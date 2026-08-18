"""External VLC player controlled over its HTTP interface.

VLC is launched with ``--extraintf http`` and a random password; commands and
status are exchanged via ``/requests/status.json``. This is fully cross-platform
and does not require any Python VLC bindings.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from typing import Optional

import requests

from .base import Player

log = logging.getLogger(__name__)

_HTTP_HOST = "127.0.0.1"
_HTTP_PORT = 18080


def _find_vlc() -> Optional[str]:
    found = shutil.which("vlc")
    if found:
        return found
    candidates = [
        r"C:\Program Files\VideoLAN\VLC\vlc.exe",
        r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
        "/Applications/VLC.app/Contents/MacOS/VLC",
        "/usr/bin/vlc",
    ]
    return next((c for c in candidates if os.path.exists(c)), None)


class VlcExternalPlayer(Player):
    key = "vlc"
    label = "VLC (external)"

    def __init__(self) -> None:
        super().__init__()
        self._process: Optional[subprocess.Popen] = None
        self._password = os.urandom(8).hex()
        self._session = requests.Session()
        self._base = f"http://{_HTTP_HOST}:{_HTTP_PORT}/requests"
        self._position = 0.0
        self._length = 0.0

    @classmethod
    def is_available(cls) -> bool:
        return _find_vlc() is not None

    def _ensure_process(self, url: str) -> None:
        if self._process is not None and self._process.poll() is None:
            return
        binary = _find_vlc()
        if binary is None:
            raise RuntimeError("VLC executable not found")
        args = [
            binary,
            "--extraintf", "http",
            "--http-host", _HTTP_HOST,
            "--http-port", str(_HTTP_PORT),
            "--http-password", self._password,
            "--no-video-title-show",
            url,
        ]
        log.info("Launching VLC: %s", binary)
        self._process = subprocess.Popen(args)

    def _status(self, params: Optional[dict] = None) -> Optional[dict]:
        try:
            response = self._session.get(
                f"{self._base}/status.json",
                params=params,
                auth=("", self._password),
                timeout=2,
            )
            if response.ok:
                return response.json()
        except requests.RequestException:
            return None
        return None

    def load(self, url: str) -> None:
        if self._process is None or self._process.poll() is not None:
            self._ensure_process(url)
        else:
            self._status({"command": "in_play", "input": url})

    def play(self) -> None:
        # pl_forceresume avoids toggling into pause if already playing.
        self._status({"command": "pl_forceresume"})

    def pause(self) -> None:
        self._status({"command": "pl_forcepause"})

    def seek(self, seconds: float) -> None:
        self._status({"command": "seek", "val": str(int(seconds))})

    def get_position(self) -> float:
        status = self._status()
        if status is None:
            return self._position
        self._position = float(status.get("time", 0.0))
        self._length = float(status.get("length", 0.0))
        return self._position

    def get_duration(self) -> float:
        return self._length

    def set_volume(self, percent: float) -> None:
        # VLC HTTP volume is 0-256 for 0-100%.
        val = int(max(0.0, min(100.0, float(percent))) / 100.0 * 256)
        self._status({"command": "volume", "val": str(val)})

    def shutdown(self) -> None:
        if self._process is not None and self._process.poll() is None:
            try:
                self._status({"command": "pl_stop"})
                self._process.terminate()
            except Exception:  # pragma: no cover
                log.debug("Error terminating VLC", exc_info=True)
        self._process = None
