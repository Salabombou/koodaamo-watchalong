"""External VLC player controlled over its HTTP interface.

VLC is launched with ``--extraintf http`` and a random password; commands and
status are exchanged via ``/requests/status.json``. This is fully cross-platform
and does not require any Python VLC bindings.
"""

from __future__ import annotations

import configparser
import logging
import math
import os
import queue
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

import requests

from .base import Player

log = logging.getLogger(__name__)

_HTTP_HOST = "127.0.0.1"


def _find_vlc(executable: str = "") -> Optional[str]:
    if executable:
        return executable if os.path.isfile(executable) and (os.name == "nt" or os.access(executable, os.X_OK)) else None
    found = shutil.which("vlc")
    if found:
        shim = Path(found).with_suffix(".shim")
        if shim.is_file():
            try:
                metadata = configparser.ConfigParser(interpolation=None)
                metadata.read_string("[shim]\n" + shim.read_text(encoding="utf-8-sig"))
                binary = metadata.get("shim", "path", fallback="").strip('"')
                if os.path.isfile(binary):
                    return binary
            except (OSError, UnicodeError, configparser.Error):
                pass
        return found
    candidates = [
        r"C:\Program Files\VideoLAN\VLC\vlc.exe",
        r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
        "/Applications/VLC.app/Contents/MacOS/VLC",
        "/usr/bin/vlc",
    ]
    return next((c for c in candidates if os.path.exists(c)), None)


class _VlcWorker:
    def __init__(self, binary: str, url: str) -> None:
        self._binary = binary
        self._url = url
        self._process: Optional[subprocess.Popen] = None
        self._password = os.urandom(8).hex()
        self._session = requests.Session()
        self._base = ""
        self.commands: queue.Queue[dict] = queue.Queue()
        self.stopped = threading.Event()
        self.snapshot = (0.0, 0.0)
        self.media_ready = False
        self.error = ""
        self.thread = threading.Thread(target=self._run, name="vlc-http")

    def _status(self, params: Optional[dict] = None) -> Optional[dict]:
        try:
            response = self._session.get(
                f"{self._base}/status.json",
                params=params,
                auth=("", self._password),
                timeout=(0.3, 0.5),
            )
            if response.ok:
                status = response.json()
                if isinstance(status, dict):
                    position = float(status.get("time", 0.0))
                    duration = float(status.get("length", 0.0))
                    fraction = status.get("position")
                    if isinstance(fraction, (int, float)) and not isinstance(fraction, bool) and 0 <= fraction <= 1 and duration > 0:
                        position = float(fraction) * duration
                    if math.isfinite(position) and math.isfinite(duration):
                        self.snapshot = (max(0.0, position), max(0.0, duration))
                    return status
        except (requests.RequestException, ValueError, TypeError):
            pass
        return None

    def _run(self) -> None:
        try:
            with socket.socket() as listener:
                listener.bind((_HTTP_HOST, 0))
                port = listener.getsockname()[1]
            self._base = f"http://{_HTTP_HOST}:{port}/requests"
            args = [
                self._binary,
                "--extraintf", "http",
                "--http-host", _HTTP_HOST,
                "--http-port", str(port),
                "--http-password", self._password,
                "--no-one-instance",
                "--start-paused",
                "--no-video-title-show",
                self._url,
            ]
            log.info("Launching VLC: %s", self._binary)
            self._process = subprocess.Popen(args)
            deadline = time.monotonic() + 10.0
            while not self.stopped.is_set():
                if self._process.poll() is not None:
                    raise RuntimeError("VLC exited before its control interface was ready")
                if self._status() is not None:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("VLC control interface did not become available")
                self.stopped.wait(0.05)

            while not self.stopped.is_set():
                if self._process.poll() is not None:
                    raise RuntimeError("VLC was closed")
                if not self.media_ready:
                    self._status()
                    self.media_ready = self.snapshot[1] > 0
                    if not self.media_ready:
                        self.stopped.wait(0.05)
                        continue
                try:
                    command = self.commands.get(timeout=0.05)
                except queue.Empty:
                    command = None
                if command is not None:
                    self._status(command)
                else:
                    self._status()
                    self.stopped.wait(0.2)
        except Exception as exc:
            self.error = str(exc)
            log.warning("VLC worker failed: %s", exc)
        finally:
            self.stopped.set()
            if self._process is not None and self._process.poll() is None:
                try:
                    self._process.terminate()
                    self._process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait(timeout=1)
                except OSError:
                    log.debug("Error terminating VLC", exc_info=True)
            self._session.close()


class VlcExternalPlayer(Player):
    key = "vlc"
    label = "VLC (external)"

    def __init__(self, executable: str = "") -> None:
        super().__init__()
        self._executable = executable
        self._worker: Optional[_VlcWorker] = None

    @classmethod
    def is_available(cls, executable: str = "") -> bool:
        return _find_vlc(executable) is not None

    def _command(self, params: dict) -> None:
        if self._worker is not None and not self._worker.stopped.is_set():
            self._worker.commands.put(params)

    def load(self, url: str) -> None:
        binary = _find_vlc(self._executable)
        if binary is None:
            raise RuntimeError("VLC executable not found")
        self.shutdown()
        self._worker = _VlcWorker(binary, url)
        self._worker.thread.start()

    def play(self) -> None:
        self._command({"command": "pl_forceresume"})

    def pause(self) -> None:
        self._command({"command": "pl_forcepause"})

    def seek(self, seconds: float) -> None:
        self._command({"command": "seek", "val": str(max(0.0, float(seconds)))})

    def get_position(self) -> float:
        return self._worker.snapshot[0] if self._worker is not None else 0.0

    def get_duration(self) -> float:
        return self._worker.snapshot[1] if self._worker is not None else 0.0

    def is_loaded(self) -> bool:
        return self._worker is not None and self._worker.media_ready and not self._worker.stopped.is_set()

    def get_error(self) -> str:
        return self._worker.error if self._worker is not None else ""

    def set_volume(self, percent: float) -> None:
        # VLC HTTP volume is 0-256 for 0-100%.
        val = int(max(0.0, min(100.0, float(percent))) / 100.0 * 256)
        self._command({"command": "volume", "val": str(val)})

    def shutdown(self) -> None:
        if self._worker is not None:
            self._worker.stopped.set()
            self._worker = None
