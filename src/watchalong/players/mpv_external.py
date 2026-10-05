"""External mpv player controlled over its JSON IPC channel.

mpv is launched with ``--input-ipc-server`` and driven with JSON commands. The
transport is a Unix domain socket on POSIX and a named pipe on Windows (the
latter requires ``pywin32``). One worker owns the process and IPC transport.
"""

from __future__ import annotations

import json
import logging
import math
import os
import queue
import select
import shutil
import socket
import subprocess
import threading
import time
from typing import Optional

from .base import Player

log = logging.getLogger(__name__)

try:  # Windows named-pipe support
    import win32file  # type: ignore
    import win32pipe  # type: ignore
    _HAVE_WIN32 = True
except Exception:  # pragma: no cover - optional dependency
    _HAVE_WIN32 = False


def _find_mpv() -> Optional[str]:
    found = shutil.which("mpv")
    if found:
        return found
    candidates = [
        r"C:\Program Files\mpv\mpv.exe",
        r"C:\Program Files\mpv.net\mpvnet.exe",
        "/Applications/mpv.app/Contents/MacOS/mpv",
        "/usr/bin/mpv",
    ]
    return next((c for c in candidates if os.path.exists(c)), None)


class _IpcTransport:
    """Newline-delimited JSON transport over a socket or named pipe."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._sock: Optional[socket.socket] = None
        self._pipe = None

    def connect(self, stopped: threading.Event, timeout: float = 10.0) -> bool:
        deadline = time.monotonic() + timeout
        while not stopped.is_set() and time.monotonic() < deadline:
            try:
                if os.name == "nt":
                    if not _HAVE_WIN32:
                        return False
                    self._pipe = win32file.CreateFile(
                        self._path,
                        win32file.GENERIC_READ | win32file.GENERIC_WRITE,
                        0, None, win32file.OPEN_EXISTING, 0, None,
                    )
                else:
                    self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    self._sock.settimeout(0.2)
                    self._sock.connect(self._path)
                return True
            except Exception:
                self.close()
                stopped.wait(0.05)
        return False

    def write(self, data: bytes) -> None:
        if self._sock is not None:
            self._sock.sendall(data)
        elif self._pipe is not None:
            win32file.WriteFile(self._pipe, data)

    def read_some(self) -> Optional[bytes]:
        if self._sock is not None:
            readable, _, _ = select.select([self._sock], [], [], 0)
            if not readable:
                return None
            return self._sock.recv(4096)
        if self._pipe is not None:
            _, available, _ = win32pipe.PeekNamedPipe(self._pipe, 0)
            if not available:
                return None
            _, data = win32file.ReadFile(self._pipe, min(available, 4096))
            return data
        return b""

    def close(self) -> None:
        try:
            if self._sock is not None:
                self._sock.close()
            elif self._pipe is not None:
                win32file.CloseHandle(self._pipe)
        except Exception:  # pragma: no cover
            pass
        self._sock = None
        self._pipe = None


class _MpvWorker:
    def __init__(self, binary: str, url: str, ipc_path: str) -> None:
        self._binary = binary
        self._url = url
        self._process: Optional[subprocess.Popen] = None
        self._ipc_path = ipc_path
        self._transport = _IpcTransport(ipc_path)
        self.commands: queue.Queue[list] = queue.Queue()
        self.stopped = threading.Event()
        self.snapshot = (0.0, 0.0)
        self.error = ""
        self._buffer = b""
        self._media_ready = False
        self.thread = threading.Thread(target=self._run, name="mpv-ipc")

    def _write(self, command: list) -> None:
        self._transport.write(json.dumps({"command": command}).encode("utf-8") + b"\n")

    def _run(self) -> None:
        try:
            args = [
                self._binary,
                f"--input-ipc-server={self._ipc_path}",
                "--force-window=yes",
                "--idle=once",
                "--pause=yes",
                "--no-terminal",
                self._url,
            ]
            log.info("Launching mpv: %s", self._binary)
            self._process = subprocess.Popen(args)
            if not self._transport.connect(self.stopped):
                if not self.stopped.is_set():
                    raise RuntimeError("Could not connect to mpv IPC")
                return
            self._write(["observe_property", 1, "time-pos"])
            self._write(["observe_property", 2, "duration"])
            pending: list[list] = []
            while not self.stopped.is_set():
                if self._process.poll() is not None:
                    raise RuntimeError("mpv was closed")
                for _ in range(32):
                    try:
                        command = self.commands.get_nowait()
                    except queue.Empty:
                        break
                    if command[0] == "loadfile":
                        self._media_ready = False
                        self.snapshot = (0.0, 0.0)
                        pending.clear()
                        self._write(command)
                    else:
                        pending.append(command)
                if self._media_ready:
                    for command in pending:
                        self._write(command)
                    pending.clear()
                chunk = self._transport.read_some()
                if chunk == b"":
                    raise RuntimeError("mpv control connection closed")
                if chunk is not None:
                    self._buffer += chunk
                    while b"\n" in self._buffer:
                        line, self._buffer = self._buffer.split(b"\n", 1)
                        self._handle_line(line)
                self.stopped.wait(0.02)
        except Exception as exc:
            self.error = str(exc)
            log.warning("mpv worker failed: %s", exc)
        finally:
            self.stopped.set()
            self._transport.close()
            if self._process is not None and self._process.poll() is None:
                try:
                    self._process.terminate()
                    self._process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait(timeout=1)
                except OSError:
                    log.debug("Error terminating mpv", exc_info=True)
            if os.name != "nt":
                try:
                    os.unlink(self._ipc_path)
                except OSError:
                    pass

    def _handle_line(self, line: bytes) -> None:
        try:
            message = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeError):
            return
        if not isinstance(message, dict):
            return
        if message.get("event") == "file-loaded":
            self._media_ready = True
        if message.get("event") != "property-change":
            return
        value = message.get("data")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return
        position, duration = self.snapshot
        if message.get("name") == "time-pos":
            position = max(0.0, float(value))
        elif message.get("name") == "duration":
            duration = max(0.0, float(value))
            self._media_ready = duration > 0
        self.snapshot = (position, duration)


class MpvExternalPlayer(Player):
    key = "mpv"
    label = "mpv (external)"

    def __init__(self) -> None:
        super().__init__()
        self._worker: Optional[_MpvWorker] = None

    @staticmethod
    def _make_ipc_path() -> str:
        token = os.urandom(4).hex()
        if os.name == "nt":
            return rf"\\.\pipe\watchalong-mpv-{token}"
        return os.path.join(
            os.environ.get("TMPDIR", "/tmp"), f"watchalong-mpv-{token}.sock"
        )

    @classmethod
    def is_available(cls) -> bool:
        return _find_mpv() is not None and (os.name != "nt" or _HAVE_WIN32)

    def load(self, url: str) -> None:
        if self._worker is None or self._worker.stopped.is_set():
            binary = _find_mpv()
            if binary is None:
                raise RuntimeError("mpv executable not found")
            if os.name == "nt" and not _HAVE_WIN32:
                raise RuntimeError("mpv synchronisation on Windows requires pywin32")
            self._worker = _MpvWorker(binary, url, self._make_ipc_path())
            self._worker.thread.start()
        else:
            self._command(["loadfile", url])

    def _command(self, command: list) -> None:
        if self._worker is not None and not self._worker.stopped.is_set():
            self._worker.commands.put(command)

    def play(self) -> None:
        self._command(["set_property", "pause", False])

    def pause(self) -> None:
        self._command(["set_property", "pause", True])

    def seek(self, seconds: float) -> None:
        self._command(["seek", float(seconds), "absolute", "exact"])

    def get_position(self) -> float:
        return self._worker.snapshot[0] if self._worker is not None else 0.0

    def get_duration(self) -> float:
        return self._worker.snapshot[1] if self._worker is not None else 0.0

    def is_loaded(self) -> bool:
        return self._worker is not None and self._worker._media_ready and not self._worker.stopped.is_set()

    def get_error(self) -> str:
        return self._worker.error if self._worker is not None else ""

    def set_volume(self, percent: float) -> None:
        self._command(["set_property", "volume", max(0.0, min(100.0, float(percent)))])

    def shutdown(self) -> None:
        if self._worker is not None:
            self._worker.stopped.set()
            self._worker = None
