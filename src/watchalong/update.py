"""Forced auto-update for the installer build.

Only active when running the installer variant as a frozen executable. On
launch the app queries this repository's GitHub Releases; if a newer version is
published it downloads the Setup installer, launches it silently, and exits so
the installer can replace the files and relaunch the app.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import tempfile
import threading
from typing import Callable, Optional

import requests
from PySide6.QtCore import Property, QObject, Signal

from . import config

log = logging.getLogger(__name__)

_API_URL = (
    f"https://api.github.com/repos/{config.GITHUB_OWNER}/{config.GITHUB_REPO}/releases/latest"
)
_TIMEOUT = 10


class UpdateInfo:
    def __init__(self, version: str, url: str, name: str) -> None:
        self.version = version
        self.url = url
        self.name = name


def _parse_version(text: str) -> tuple[int, ...]:
    parts: list[int] = []
    for chunk in text.strip().lstrip("vV").split("."):
        digits = ""
        for ch in chunk:
            if ch.isdigit():
                digits += ch
            else:
                break
        parts.append(int(digits) if digits else 0)
    return tuple(parts) or (0,)


def _is_newer(latest: str, current: str) -> bool:
    return _parse_version(latest) > _parse_version(current)


def _pick_installer_asset(assets: list) -> Optional[dict]:
    for asset in assets:
        name = str(asset.get("name", "")).lower()
        if name.endswith(".exe") and "setup" in name:
            return asset
    return None


def check_for_update() -> Optional[UpdateInfo]:
    """Return update info if a newer installer is available, else ``None``."""
    if config.APP_VARIANT != "installer" or not getattr(sys, "frozen", False):
        return None
    try:
        resp = requests.get(
            _API_URL,
            timeout=_TIMEOUT,
            headers={"Accept": "application/vnd.github+json"},
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        log.warning("Update check failed", exc_info=True)
        return None

    tag = str(data.get("tag_name", ""))
    if not tag or not _is_newer(tag, config.APP_VERSION):
        return None
    asset = _pick_installer_asset(data.get("assets", []))
    if asset is None:
        return None
    return UpdateInfo(tag.lstrip("vV"), asset["browser_download_url"], asset["name"])


def download_installer(
    info: UpdateInfo, progress: Optional[Callable[[float], None]] = None
) -> Optional[str]:
    """Download the installer to a temp file; return its path or ``None``."""
    try:
        dest = os.path.join(tempfile.gettempdir(), info.name)
        with requests.get(info.url, stream=True, timeout=_TIMEOUT) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("Content-Length", 0))
            done = 0
            with open(dest, "wb") as fh:
                for chunk in resp.iter_content(chunk_size=256 * 1024):
                    if not chunk:
                        continue
                    fh.write(chunk)
                    done += len(chunk)
                    if progress is not None and total:
                        progress(done / total)
        return dest
    except Exception:
        log.warning("Installer download failed", exc_info=True)
        return None


def launch_installer(path: str) -> bool:
    """Run the Inno Setup installer silently; return ``True`` if it spawned."""
    try:
        subprocess.Popen(
            [path, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"],
            close_fds=True,
        )
        return True
    except Exception:
        log.warning("Failed to launch installer", exc_info=True)
        return False


class UpdateController(QObject):
    """Drives the QML update window: downloads then launches the installer."""

    changed = Signal()
    finished = Signal()

    def __init__(self, info: UpdateInfo, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._info = info
        self._progress = 0.0
        self._status = f"Downloading update {info.version}…"
        self.launched = False
        self._thread: Optional[threading.Thread] = None

    @Property(float, notify=changed)
    def progress(self) -> float:
        return self._progress

    @Property(str, notify=changed)
    def statusText(self) -> str:
        return self._status

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="updater", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        path = download_installer(self._info, progress=self._on_progress)
        if path and launch_installer(path):
            self.launched = True
            self._set_status("Restarting to finish update…")
        else:
            self._set_status("Update failed — starting current version…")
        self.finished.emit()

    def _on_progress(self, fraction: float) -> None:
        self._progress = max(0.0, min(1.0, fraction))
        self.changed.emit()

    def _set_status(self, text: str) -> None:
        self._status = text
        self.changed.emit()
