"""Application controller: wires the torrent, room, and player subsystems and
exposes a small API to QML.

The host is authoritative. It seeds the file, broadcasts a state heartbeat, and
applies play/pause/seek. Clients add the shared magnet, stream it locally, and
follow the host's state (subject to the room's ``allow_pause`` / ``allow_seek``
options).
"""

from __future__ import annotations

import logging
import os
import time
from typing import Optional

from PySide6.QtCore import Property, QObject, QTimer, Signal, Slot

from . import config
from .players.base import Player
from .players.qt_media import QtMediaPlayer
from .players.mpv_external import MpvExternalPlayer
from .players.vlc_external import VlcExternalPlayer
from .room import protocol
from .room.channel import RoomChannel
from .room.protocol import RoomOptions, RoomState
from .torrent.engine import TorrentEngine, TorrentProgress
from .torrent.stream_server import StreamServer

log = logging.getLogger(__name__)

_DRIFT_THRESHOLD = 2.0  # seconds of allowed desync before a corrective seek


def _format_rate(bytes_per_s: float) -> str:
    value = float(bytes_per_s)
    for unit in ("B/s", "KB/s", "MB/s", "GB/s"):
        if value < 1024 or unit == "GB/s":
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB/s"


class AppController(QObject):
    changed = Signal()
    # High-frequency playback updates; kept separate from ``changed`` so the
    # whole QML binding graph is not re-evaluated several times per second.
    positionChanged = Signal()
    errorOccurred = Signal(str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._self_id = os.urandom(6).hex()

        self._engine = TorrentEngine()
        self._engine.progress_updated.connect(self._on_progress)
        self._engine.metadata_ready.connect(self._on_metadata_ready)
        self._engine.error.connect(self.errorOccurred)

        self._stream = StreamServer(self._engine)
        self._stream.start()

        self._channel: Optional[RoomChannel] = None
        self._state = RoomState(options=RoomOptions())
        self._is_host = False
        self._connected = False
        self._status = "Not connected"

        # players
        self._builtin = QtMediaPlayer()
        self._external: dict[str, Player] = {}
        self._player: Optional[Player] = None
        self._player_key = self._default_player_key()
        self._local_position = 0.0
        self._position = 0.0
        self._duration = 0.0
        self._volume = 100

        # progress cache
        self._progress = 0.0
        self._peers = 0
        self._down = "0.0 B/s"
        self._up = "0.0 B/s"

        # host heartbeat
        self._heartbeat = QTimer(self)
        self._heartbeat.setInterval(1000)
        self._heartbeat.timeout.connect(self._send_heartbeat)

        # UI refresh timer drives the seek bar / time labels from the player.
        self._ui_timer = QTimer(self)
        self._ui_timer.setInterval(250)
        self._ui_timer.timeout.connect(self._refresh_playback)

    # --- QML properties ------------------------------------------------------

    @Property(bool, notify=changed)
    def connected(self) -> bool:
        return self._connected

    @Property(bool, notify=changed)
    def isHost(self) -> bool:
        return self._is_host

    @Property(str, notify=changed)
    def statusText(self) -> str:
        return self._status

    @Property(str, notify=changed)
    def mediaName(self) -> str:
        return self._state.media_name

    @Property(bool, notify=changed)
    def hasMedia(self) -> bool:
        return bool(self._state.media_magnet)

    @Property(float, notify=changed)
    def progress(self) -> float:
        return self._progress

    @Property(int, notify=changed)
    def peers(self) -> int:
        return self._peers

    @Property(str, notify=changed)
    def downRateText(self) -> str:
        return self._down

    @Property(str, notify=changed)
    def upRateText(self) -> str:
        return self._up

    @Property(bool, notify=changed)
    def playing(self) -> bool:
        return self._state.playing

    @Property(bool, notify=changed)
    def allowPause(self) -> bool:
        return self._state.options.allow_pause

    @Property(bool, notify=changed)
    def allowSeek(self) -> bool:
        return self._state.options.allow_seek

    @Property(str, notify=changed)
    def playerKey(self) -> str:
        return self._player_key

    @Property(float, notify=positionChanged)
    def position(self) -> float:
        return self._position

    @Property(float, notify=positionChanged)
    def duration(self) -> float:
        return self._duration

    @Property(int, notify=changed)
    def volume(self) -> int:
        return self._volume

    @Property("QVariantList", notify=changed)
    def availablePlayers(self) -> list:
        specs = [
            ("builtin", QtMediaPlayer.label, QtMediaPlayer.is_available()),
            ("mpv", MpvExternalPlayer.label, MpvExternalPlayer.is_available()),
            ("vlc", VlcExternalPlayer.label, VlcExternalPlayer.is_available()),
        ]
        return [
            {"key": key, "label": label, "available": available}
            for key, label, available in specs
        ]

    # --- QML slots -----------------------------------------------------------

    @Slot(QObject)
    def setVideoItem(self, item: QObject) -> None:
        self._builtin.set_video_output(item)
        if self._player_key == "builtin":
            self._player = self._builtin
            self._player.set_position_callback(self._on_local_position)
            self._player.set_volume(self._volume)
            # Media may already be loaded if the surface arrived late.
            if self._state.media_magnet and self._stream.url:
                self._load_current_player()

    @Slot(str, str, bool)
    def startRoom(self, room_code: str, password: str, as_host: bool) -> None:
        room_code = room_code.strip()
        if not room_code:
            self.errorOccurred.emit("Room code is required")
            return
        if self._channel is not None:
            self.leave()

        self._is_host = as_host
        self._state = RoomState(host_id=self._self_id if as_host else "", options=RoomOptions())
        self._set_status("Connecting…")

        self._channel = RoomChannel(room_code, password, self)
        self._channel.message_received.connect(self._on_message)
        self._channel.connected.connect(self._on_channel_connected)
        self._channel.disconnected.connect(self._on_channel_disconnected)
        self._channel.start()

        # Ensure a player is selected.
        if self._player is None:
            self._select_player_internal(self._player_key)
        self._notify()

    @Slot(str)
    def shareFile(self, path: str) -> None:
        if not self._is_host:
            return
        path = self._normalize_path(path)
        if not path or not os.path.isfile(path):
            self.errorOccurred.emit(f"File not found: {path}")
            return
        try:
            magnet = self._engine.seed_file(path)
        except Exception as exc:  # pragma: no cover
            self.errorOccurred.emit(f"Failed to share file: {exc}")
            return
        self._state.media_magnet = magnet
        self._state.media_name = os.path.basename(path)
        self._state.playing = False
        self._state.position = 0.0
        self._set_status(f"Sharing: {self._state.media_name}")
        self._load_current_player()
        self._broadcast_set_media()
        self._broadcast_state()
        self._notify()

    @Slot(str)
    def selectPlayer(self, key: str) -> None:
        self._select_player_internal(key)
        self._notify()

    @Slot(result=float)
    def currentPosition(self) -> float:
        return self._current_position()

    @Slot(int)
    def setVolume(self, percent: int) -> None:
        self._volume = max(0, min(100, int(percent)))
        if self._player is not None:
            self._player.set_volume(self._volume)
        self._notify()

    @Slot()
    def playPressed(self) -> None:
        if not self._can_control_pause():
            return
        self._apply_playing(True, local_origin=True)

    @Slot()
    def pausePressed(self) -> None:
        if not self._can_control_pause():
            return
        self._apply_playing(False, local_origin=True)

    @Slot(float)
    def seekTo(self, seconds: float) -> None:
        if not self._can_control_seek():
            return
        self._apply_seek(float(seconds), local_origin=True)

    @Slot(bool, bool)
    def setOptions(self, allow_pause: bool, allow_seek: bool) -> None:
        if not self._is_host:
            return
        self._state.options = RoomOptions(allow_pause=allow_pause, allow_seek=allow_seek)
        if self._channel is not None:
            self._channel.publish(
                protocol.make(protocol.OPTIONS, self._self_id, options=self._state.options.to_dict())
            )
        self._notify()

    @Slot()
    def leave(self) -> None:
        if self._channel is not None:
            self._channel.stop()
            self._channel = None
        self._heartbeat.stop()
        self._ui_timer.stop()
        self._connected = False
        self._is_host = False
        self._position = 0.0
        self._duration = 0.0
        self._set_status("Not connected")
        self._notify()

    # --- player management ---------------------------------------------------

    def _get_player(self, key: str) -> Optional[Player]:
        if key == "builtin":
            return self._builtin
        if key not in self._external:
            if key == "mpv":
                self._external[key] = MpvExternalPlayer()
            elif key == "vlc":
                self._external[key] = VlcExternalPlayer()
            else:
                return None
        return self._external[key]

    @staticmethod
    def _default_player_key() -> str:
        if QtMediaPlayer.is_available():
            return "builtin"
        return AppController._first_available_external() or "builtin"

    @staticmethod
    def _first_available_external() -> Optional[str]:
        if MpvExternalPlayer.is_available():
            return "mpv"
        if VlcExternalPlayer.is_available():
            return "vlc"
        return None

    def _select_player_internal(self, key: str) -> None:
        new_player = self._get_player(key)
        if new_player is None:
            # The built-in surface is created lazily by QML and wired up in
            # setVideoItem(); if it simply isn't ready yet, defer without error.
            if key == "builtin":
                if QtMediaPlayer.is_available():
                    self._player_key = "builtin"
                    return
                fallback = self._first_available_external()
                if fallback is not None:
                    self._select_player_internal(fallback)
                    return
            self.errorOccurred.emit(f"Player '{key}' is not available")
            return
        previous = self._player
        if previous is not None and previous is not new_player and previous is not self._builtin:
            previous.shutdown()
        elif previous is self._builtin and previous is not new_player and previous is not None:
            previous.pause()

        self._player = new_player
        self._player_key = key
        self._player.set_position_callback(self._on_local_position)
        self._player.set_volume(self._volume)
        if self._state.media_magnet and self._stream.url:
            self._load_current_player()

    def _load_current_player(self) -> None:
        if self._player is None or not self._stream.url:
            return
        self._player.load(self._stream.url)
        self._player.set_paused(not self._state.playing)
        self._player.set_volume(self._volume)
        if self._state.position > 0:
            self._player.seek(self._state.position)
        self._ui_timer.start()

    def _on_local_position(self, seconds: float) -> None:
        self._local_position = seconds

    def _current_position(self) -> float:
        if self._player is not None:
            try:
                return self._player.get_position()
            except Exception:  # pragma: no cover
                return self._local_position
        return self._local_position

    def _current_duration(self) -> float:
        if self._player is not None:
            try:
                return self._player.get_duration()
            except Exception:  # pragma: no cover
                return self._duration
        return self._duration

    def _refresh_playback(self) -> None:
        position = self._current_position()
        duration = self._current_duration()
        if position != self._position or duration != self._duration:
            self._position = position
            self._duration = duration
            self.positionChanged.emit()

    # --- playback commands ---------------------------------------------------

    def _apply_playing(self, playing: bool, local_origin: bool) -> None:
        self._state.playing = playing
        if self._player is not None:
            self._player.set_paused(not playing)
        if local_origin and self._channel is not None:
            msg_type = protocol.PLAY if playing else protocol.PAUSE
            self._channel.publish(protocol.make(msg_type, self._self_id, position=self._current_position()))
        if self._is_host:
            self._broadcast_state()
        self._notify()

    def _apply_seek(self, seconds: float, local_origin: bool) -> None:
        self._state.position = seconds
        if self._player is not None:
            self._player.seek(seconds)
        if local_origin and self._channel is not None:
            self._channel.publish(protocol.make(protocol.SEEK, self._self_id, position=seconds))
        if self._is_host:
            self._broadcast_state()

    # --- broadcasting (host) -------------------------------------------------

    def _broadcast_set_media(self) -> None:
        if self._channel is None:
            return
        self._channel.publish(
            protocol.make(
                protocol.SET_MEDIA,
                self._self_id,
                magnet=self._state.media_magnet,
                name=self._state.media_name,
            )
        )

    def _broadcast_state(self) -> None:
        if self._channel is None or not self._is_host:
            return
        self._channel.publish(
            protocol.make(
                protocol.STATE,
                self._self_id,
                magnet=self._state.media_magnet,
                name=self._state.media_name,
                playing=self._state.playing,
                position=self._current_position(),
                options=self._state.options.to_dict(),
            )
        )

    def _send_heartbeat(self) -> None:
        if self._is_host and self._state.media_magnet:
            self._state.position = self._current_position()
            self._broadcast_state()

    # --- incoming messages ---------------------------------------------------

    def _on_message(self, message: dict) -> None:
        sender = message.get("from")
        if sender == self._self_id:
            return
        msg_type = message.get("t")

        if msg_type == protocol.HELLO:
            if self._is_host and self._state.media_magnet:
                self._broadcast_set_media()
                self._broadcast_state()
            return
        if msg_type == protocol.REQUEST_STATE:
            if self._is_host:
                self._broadcast_set_media()
                self._broadcast_state()
            return
        if msg_type == protocol.SET_MEDIA:
            if not self._is_host:
                self._handle_set_media(message)
            return
        if msg_type == protocol.OPTIONS:
            self._state.options = RoomOptions.from_dict(message.get("options", {}))
            self._notify()
            return
        if msg_type == protocol.STATE:
            if not self._is_host:
                self._handle_host_state(message)
            return
        if msg_type in (protocol.PLAY, protocol.PAUSE, protocol.SEEK):
            self._handle_control_request(message)
            return

    def _handle_set_media(self, message: dict) -> None:
        magnet = message.get("magnet", "")
        if not magnet or magnet == self._state.media_magnet:
            return
        self._state.media_magnet = magnet
        self._state.media_name = message.get("name", "")
        self._set_status(f"Loading: {self._state.media_name}")
        try:
            self._engine.add_magnet(magnet)
        except Exception as exc:  # pragma: no cover
            self.errorOccurred.emit(f"Failed to load shared media: {exc}")
        self._notify()

    def _handle_host_state(self, message: dict) -> None:
        magnet = message.get("magnet", "")
        if magnet and magnet != self._state.media_magnet:
            self._handle_set_media({"magnet": magnet, "name": message.get("name", "")})

        self._state.options = RoomOptions.from_dict(message.get("options", {}))
        host_playing = bool(message.get("playing", False))
        host_position = float(message.get("position", 0.0))

        if host_playing != self._state.playing:
            self._apply_playing(host_playing, local_origin=False)

        if abs(self._current_position() - host_position) > _DRIFT_THRESHOLD:
            self._apply_seek(host_position, local_origin=False)

        self._notify()

    def _handle_control_request(self, message: dict) -> None:
        # Only the host acts on control requests and re-broadcasts authoritative state.
        if not self._is_host:
            return
        msg_type = message.get("t")
        if msg_type == protocol.SEEK:
            if self._state.options.allow_seek:
                self._apply_seek(float(message.get("position", 0.0)), local_origin=False)
                self._broadcast_state()
        elif msg_type in (protocol.PLAY, protocol.PAUSE):
            if self._state.options.allow_pause:
                self._apply_playing(msg_type == protocol.PLAY, local_origin=False)

    # --- signal handlers -----------------------------------------------------

    def _on_channel_connected(self) -> None:
        self._connected = True
        self._set_status("Connected" if not self._is_host else "Hosting — share a file")
        if self._is_host:
            self._heartbeat.start()
        else:
            if self._channel is not None:
                self._channel.publish(protocol.make(protocol.HELLO, self._self_id))
                self._channel.publish(protocol.make(protocol.REQUEST_STATE, self._self_id))
        self._notify()

    def _on_channel_disconnected(self) -> None:
        self._connected = False
        self._set_status("Disconnected — reconnecting…")
        self._notify()

    def _on_metadata_ready(self) -> None:
        if not self._is_host and self._state.media_magnet:
            self._load_current_player()
            self._set_status(f"Playing: {self._state.media_name}")
            self._notify()

    def _on_progress(self, progress: TorrentProgress) -> None:
        self._progress = progress.progress
        self._peers = progress.num_peers
        self._down = _format_rate(progress.download_rate)
        self._up = _format_rate(progress.upload_rate)
        if progress.name and not self._state.media_name:
            self._state.media_name = progress.name
        self._notify()

    # --- helpers -------------------------------------------------------------

    def _can_control_pause(self) -> bool:
        return self._is_host or self._state.options.allow_pause

    def _can_control_seek(self) -> bool:
        return self._is_host or self._state.options.allow_seek

    @staticmethod
    def _normalize_path(path: str) -> str:
        if path.startswith("file:///"):
            from urllib.parse import unquote, urlparse

            parsed = urlparse(path)
            local = unquote(parsed.path)
            if os.name == "nt" and local.startswith("/"):
                local = local[1:]
            return local
        return path

    def _set_status(self, text: str) -> None:
        self._status = text

    def _notify(self) -> None:
        self.changed.emit()

    def shutdown(self) -> None:
        self.leave()
        for player in self._external.values():
            player.shutdown()
        self._builtin.shutdown()
        self._stream.stop()
        self._engine.shutdown()
