"""External mpv player controlled over its JSON IPC channel.

mpv is launched with ``--input-ipc-server`` and driven with JSON commands. The
transport is a Unix domain socket on POSIX and a named pipe on Windows (the
latter requires ``pywin32``). Playback still works without the IPC transport,
but play/pause/seek synchronisation will not.
"""

from __future__ import annotations

import json
import logging
import os
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

    def connect(self, timeout: float = 10.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
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
                    self._sock.connect(self._path)
                return True
            except Exception:
                time.sleep(0.2)
        return False

    def write(self, data: bytes) -> None:
        if self._sock is not None:
            self._sock.sendall(data)
        elif self._pipe is not None:
            win32file.WriteFile(self._pipe, data)

    def read_some(self) -> bytes:
        if self._sock is not None:
            return self._sock.recv(4096)
        if self._pipe is not None:
            _, data = win32file.ReadFile(self._pipe, 4096)
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


class MpvExternalPlayer(Player):
    key = "mpv"
    label = "mpv (external)"

    def __init__(self) -> None:
        super().__init__()
        self._process: Optional[subprocess.Popen] = None
        self._ipc_path = self._make_ipc_path()
        self._transport: Optional[_IpcTransport] = None
        self._reader: Optional[threading.Thread] = None
        self._running = False
        self._position = 0.0
        self._duration = 0.0
        self._buffer = b""

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
        return _find_mpv() is not None

    def load(self, url: str) -> None:
        if self._process is None or self._process.poll() is not None:
            self._launch(url)
        else:
            self._command(["loadfile", url])

    def _launch(self, url: str) -> None:
        binary = _find_mpv()
        if binary is None:
            raise RuntimeError("mpv executable not found")
        args = [
            binary,
            f"--input-ipc-server={self._ipc_path}",
            "--force-window=yes",
            "--idle=once",
            "--no-terminal",
            url,
        ]
        log.info("Launching mpv: %s", binary)
        self._process = subprocess.Popen(args)
        self._start_ipc()

    def _start_ipc(self) -> None:
        self._transport = _IpcTransport(self._ipc_path)
        self._running = True
        self._reader = threading.Thread(target=self._read_loop, name="mpv-ipc", daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        if self._transport is None or not self._transport.connect():
            log.warning("Could not connect to mpv IPC (%s)", self._ipc_path)
            return
        # Observe time-pos so we receive position updates as events.
        self._command(["observe_property", 1, "time-pos"])
        self._command(["observe_property", 2, "duration"])
        while self._running:
            try:
                chunk = self._transport.read_some()
            except Exception:
                break
            if not chunk:
                break
            self._buffer += chunk
            while b"\n" in self._buffer:
                line, self._buffer = self._buffer.split(b"\n", 1)
                self._handle_line(line)

    def _handle_line(self, line: bytes) -> None:
        try:
            message = json.loads(line.decode("utf-8"))
        except Exception:
            return
        if message.get("event") == "property-change" and message.get("name") == "time-pos":
            value = message.get("data")
            if isinstance(value, (int, float)):
                self._position = float(value)
                self._emit_position(self._position)
        elif message.get("event") == "property-change" and message.get("name") == "duration":
            value = message.get("data")
            if isinstance(value, (int, float)):
                self._duration = float(value)

    def _command(self, command: list) -> None:
        if self._transport is None:
            return
        payload = json.dumps({"command": command}).encode("utf-8") + b"\n"
        try:
            self._transport.write(payload)
        except Exception:  # pragma: no cover
            log.debug("mpv IPC write failed", exc_info=True)

    def play(self) -> None:
        self._command(["set_property", "pause", False])

    def pause(self) -> None:
        self._command(["set_property", "pause", True])

    def seek(self, seconds: float) -> None:
        self._command(["seek", float(seconds), "absolute", "exact"])

    def get_position(self) -> float:
        return self._position

    def get_duration(self) -> float:
        return self._duration

    def set_volume(self, percent: float) -> None:
        self._command(["set_property", "volume", max(0.0, min(100.0, float(percent)))])

    def shutdown(self) -> None:
        self._running = False
        try:
            self._command(["quit"])
        except Exception:  # pragma: no cover
            pass
        if self._transport is not None:
            self._transport.close()
        if self._process is not None and self._process.poll() is None:
            try:
                self._process.terminate()
            except Exception:  # pragma: no cover
                pass
        self._process = None
