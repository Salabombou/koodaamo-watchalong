"""libtorrent-based file sharing with sequential streaming support.

The host seeds a local file and produces a magnet URI; clients add that magnet
and download it sequentially. BitTorrent handles peer-to-peer piece relaying
between clients automatically, so the host is not the sole source once other
clients have data.
"""

from __future__ import annotations

import base64
import logging
import os
from dataclasses import dataclass
from typing import Optional

import libtorrent as lt
from PySide6.QtCore import QObject, QTimer, Signal

from .. import config

log = logging.getLogger(__name__)


@dataclass
class TorrentProgress:
    name: str = ""
    progress: float = 0.0
    download_rate: float = 0.0  # bytes/s
    upload_rate: float = 0.0    # bytes/s
    num_peers: int = 0
    num_seeds: int = 0
    state: str = ""
    has_metadata: bool = False
    total_wanted: int = 0
    total_done: int = 0
    is_seeding: bool = False


def _alert_mask() -> int:
    category = getattr(lt, "alert_category", None)
    if category is not None:  # libtorrent 2.x
        return int(category.status | category.error | category.storage)
    legacy = lt.alert.category_t  # libtorrent 1.x fallback
    return int(
        legacy.status_notification
        | legacy.error_notification
        | legacy.storage_notification
    )


class TorrentEngine(QObject):
    """Owns a single libtorrent session and (at most) one active torrent."""

    progress_updated = Signal(TorrentProgress)
    metadata_ready = Signal()
    error = Signal(str)

    def __init__(self, download_dir: str | None = None, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._download_dir = download_dir or config.default_download_dir()

        settings = {
            "listen_interfaces": f"0.0.0.0:{config.TORRENT_LISTEN_PORT},[::]:{config.TORRENT_LISTEN_PORT}",
            "enable_dht": True,
            "enable_lsd": True,
            "enable_upnp": True,
            "enable_natpmp": True,
            "alert_mask": _alert_mask(),
            "user_agent": f"{config.APP_ID}/{config.APP_VERSION}",
        }
        self._ses = lt.session(settings)
        for host, port in config.DHT_BOOTSTRAP_NODES:
            try:
                self._ses.add_dht_router(host, port)
            except Exception:  # pragma: no cover
                log.debug("Could not add DHT router %s:%s", host, port, exc_info=True)

        self._handle: Optional["lt.torrent_handle"] = None
        self._file_index: int = -1
        self._is_seeding: bool = False
        self._torrent_file: bytes = b""  # full .torrent of the seeded file (host)

        self._timer = QTimer(self)
        self._timer.setInterval(1000)
        self._timer.timeout.connect(self._tick)
        self._timer.start()

    # --- properties ----------------------------------------------------------

    @property
    def download_dir(self) -> str:
        return self._download_dir

    @property
    def handle(self):  # noqa: ANN201 - libtorrent type
        return self._handle

    def has_active_torrent(self) -> bool:
        return self._handle is not None and self._handle.is_valid()

    # --- host: seed a file ---------------------------------------------------

    def seed_file(self, path: str) -> str:
        """Create a torrent from ``path``, start seeding, and return the magnet."""
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        parent = os.path.dirname(path)

        fs = lt.file_storage()
        lt.add_files(fs, path)
        creator = lt.create_torrent(fs, piece_size=0)  # 0 -> auto piece size
        for tracker in config.DEFAULT_TRACKERS:
            creator.add_tracker(tracker, 0)
        creator.set_creator(f"{config.APP_ID}/{config.APP_VERSION}")
        lt.set_piece_hashes(creator, parent)

        entry = creator.generate()
        torrent_bytes = lt.bencode(entry)
        info = lt.torrent_info(lt.bdecode(torrent_bytes))
        self._torrent_file = bytes(torrent_bytes)

        params = lt.add_torrent_params()
        params.ti = info
        params.save_path = parent
        params.flags |= lt.torrent_flags.seed_mode

        self._replace_handle(self._ses.add_torrent(params), seeding=True)
        self._file_index = self._pick_video_file(info)

        magnet = lt.make_magnet_uri(self._handle)
        self.metadata_ready.emit()
        log.info("Seeding %s -> %s", path, magnet)
        return magnet

    # --- client: add a magnet ------------------------------------------------

    def add_magnet(self, magnet: str) -> None:
        params = lt.parse_magnet_uri(magnet)
        params.save_path = self._download_dir
        try:
            existing = list(params.trackers)
            params.trackers = existing + [t for t in config.DEFAULT_TRACKERS if t not in existing]
        except Exception:  # pragma: no cover
            log.debug("Could not merge trackers", exc_info=True)
        params.flags |= lt.torrent_flags.sequential_download

        self._replace_handle(self._ses.add_torrent(params), seeding=False)
        self._file_index = -1  # resolved when metadata arrives
        log.info("Added magnet: %s", magnet[:80])

    def torrent_file_b64(self) -> str:
        """Return the active torrent's full metadata, base64-encoded (host)."""
        if not self._torrent_file:
            return ""
        return base64.b64encode(self._torrent_file).decode("ascii")

    def add_torrent_metadata(self, meta_b64: str) -> None:
        """Add a torrent from metadata supplied out-of-band (no swarm fetch)."""
        raw = base64.b64decode(meta_b64)
        info = lt.torrent_info(lt.bdecode(raw))
        params = lt.add_torrent_params()
        params.ti = info
        params.save_path = self._download_dir
        params.flags |= lt.torrent_flags.sequential_download

        self._replace_handle(self._ses.add_torrent(params), seeding=False)
        self._file_index = self._pick_video_file(info)
        log.info("Added torrent from embedded metadata: %s", info.name())
        self.metadata_ready.emit()

    def has_metadata(self) -> bool:
        if not self.has_active_torrent():
            return False
        try:
            return bool(self._handle.status().has_metadata)
        except Exception:  # pragma: no cover
            return False

    # --- handle management ---------------------------------------------------

    def _replace_handle(self, handle, seeding: bool) -> None:
        if self.has_active_torrent():
            try:
                self._ses.remove_torrent(self._handle)
            except Exception:  # pragma: no cover
                log.debug("Could not remove previous torrent", exc_info=True)
        self._handle = handle
        self._is_seeding = seeding
        if handle is not None and handle.is_valid():
            handle.set_sequential_download(True)

    def _pick_video_file(self, info) -> int:
        files = info.files()
        best_i, best_size = -1, -1
        for i in range(files.num_files()):
            ext = os.path.splitext(files.file_name(i).lower())[1]
            size = files.file_size(i)
            if ext in config.VIDEO_EXTENSIONS and size > best_size:
                best_i, best_size = i, size
        if best_i == -1:  # no recognised video: fall back to the largest file
            for i in range(files.num_files()):
                size = files.file_size(i)
                if size > best_size:
                    best_i, best_size = i, size
        return best_i

    def _handle_info(self):
        """Return the active torrent's ``torrent_info`` across libtorrent versions."""
        handle = self._handle
        getter = (
            getattr(handle, "torrent_file", None)
            or getattr(handle, "get_torrent_info", None)
            or getattr(handle, "torrent_info", None)
        )
        return getter() if getter is not None else None

    def _selected(self):
        """Return ``(torrent_info, file_index)`` or ``None`` if not ready."""
        if not self.has_active_torrent():
            return None
        status = self._handle.status()
        if not status.has_metadata:
            return None
        info = self._handle_info()
        if info is None:
            return None
        if self._file_index < 0:
            self._file_index = self._pick_video_file(info)
        return info, self._file_index

    # --- streaming helpers (used by the HTTP stream server) ------------------

    def file_size(self) -> Optional[int]:
        sel = self._selected()
        if sel is None:
            return None
        info, fi = sel
        return info.files().file_size(fi)

    def file_offset(self) -> Optional[int]:
        sel = self._selected()
        if sel is None:
            return None
        info, fi = sel
        return info.files().file_offset(fi)

    def piece_length(self) -> Optional[int]:
        sel = self._selected()
        if sel is None:
            return None
        info, _ = sel
        return info.piece_length()

    def file_path_on_disk(self) -> Optional[str]:
        sel = self._selected()
        if sel is None:
            return None
        info, fi = sel
        rel = info.files().file_path(fi)
        return os.path.join(self._handle.status().save_path, rel)

    def have_piece(self, index: int) -> bool:
        if not self.has_active_torrent():
            return False
        return self._handle.have_piece(index)

    def prioritize_from(self, first_piece: int, window: int = 12) -> None:
        """Set short deadlines on a window of pieces starting at ``first_piece``."""
        if not self.has_active_torrent():
            return
        sel = self._selected()
        if sel is None:
            return
        info, _ = sel
        num_pieces = info.num_pieces()
        for k in range(window):
            piece = first_piece + k
            if 0 <= piece < num_pieces:
                try:
                    self._handle.set_piece_deadline(piece, (k + 1) * 100)
                except Exception:  # pragma: no cover
                    pass

    # --- periodic tick -------------------------------------------------------

    def _tick(self) -> None:
        self._process_alerts()
        if not self.has_active_torrent():
            return
        st = self._handle.status()
        self.progress_updated.emit(
            TorrentProgress(
                name=st.name or "",
                progress=st.progress,
                download_rate=st.download_rate,
                upload_rate=st.upload_rate,
                num_peers=st.num_peers,
                num_seeds=st.num_seeds,
                state=str(st.state),
                has_metadata=st.has_metadata,
                total_wanted=max(st.total_wanted, 0),
                total_done=st.total_done,
                is_seeding=self._is_seeding,
            )
        )

    def _process_alerts(self) -> None:
        for alert in self._ses.pop_alerts():
            if isinstance(alert, lt.metadata_received_alert):
                if self.has_active_torrent():
                    info = self._handle_info()
                    if info is not None:
                        self._file_index = self._pick_video_file(info)
                        log.info("Metadata received: %s", info.name())
                        self.metadata_ready.emit()
            elif isinstance(alert, lt.torrent_error_alert):
                log.error("Torrent error: %s", alert.message())
                self.error.emit(alert.message())

    def shutdown(self) -> None:
        self._timer.stop()
        try:
            if self.has_active_torrent():
                self._ses.remove_torrent(self._handle)
        except Exception:  # pragma: no cover
            log.debug("Error during torrent shutdown", exc_info=True)
        try:
            # Pausing the session lets its native destructor exit promptly
            # instead of stalling on tracker/peer teardown.
            self._ses.pause()
        except Exception:  # pragma: no cover
            log.debug("Error pausing session on shutdown", exc_info=True)
