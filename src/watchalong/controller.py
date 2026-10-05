"""Coordinates players and host-authoritative watchalong rooms."""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Optional

from PySide6.QtCore import Property, QObject, QTimer, Qt, Signal, Slot

from . import config
from .players.base import Player
from .players.qt_media import QtMediaPlayer
from .players.mpv_external import MpvExternalPlayer
from .players.vlc_external import VlcExternalPlayer
from .room import protocol
from .room.channel import RoomChannel
from .room.clock import ClockSync
from .room.participants import ParticipantsModel
from .room.protocol import RoomOptions, RoomState
from .room.roster import Roster
from .settings import SettingsController
from .torrent.engine import TorrentEngine, TorrentProgress, prepare_file_isolated
from .torrent.stream_server import StreamServer

log = logging.getLogger(__name__)

_DRIFT_THRESHOLD = 0.4


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
    countdownChanged = Signal()
    errorOccurred = Signal(str)
    # Emitted when a user tries to host a room that already has a host.
    roomExists = Signal(str)
    _seed_finished = Signal(int, str, bytes, str)

    def __init__(self, parent: QObject | None = None, settings: SettingsController | None = None) -> None:
        super().__init__(parent)
        self._settings = settings
        self._self_id = settings.identity if settings is not None else os.urandom(16).hex()

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
        self._instance = os.urandom(8).hex()
        self._roster = Roster()
        self._participants = ParticipantsModel(self)
        self._clock = ClockSync()
        self._self_ready = False
        self._member_sequence = 0
        self._loaded_last = False
        self._deadline = 0.0
        self._applied_revision = -1
        self._host_seen = time.monotonic()
        self._host_lost = False
        self._pings: dict[float, float] = {}
        self._ticks = 0
        self._transfer_target = ""
        self._expected_transfer: dict = {}
        self._version_warned = False
        self._claim_until = 0.0
        self._preparation = 0
        self._preparation_stop: threading.Event | None = None
        self._media_preparing = False
        self._seed_finished.connect(self._on_seed_finished)

        # players
        self._builtin = QtMediaPlayer()
        self._external: dict[str, Player] = {}
        self._player: Optional[Player] = None
        self._player_key = settings.values["defaultPlayer"] if settings is not None else self._default_player_key()
        self._player_error = ""
        self._player_loading = False
        self._local_position = 0.0
        self._position = 0.0
        self._duration = 0.0
        self._volume = 100
        # Bumped on every media change so the (static) stream URL becomes unique
        # and players reload instead of resuming the previous video.
        self._media_token = 0

        # progress cache
        self._progress = 0.0
        self._peers = 0
        self._down = "0.0 B/s"
        self._up = "0.0 B/s"

        # host heartbeat
        self._heartbeat = QTimer(self)
        self._heartbeat.setInterval(1000)
        self._heartbeat.timeout.connect(self._send_heartbeat)

        self._start_timer = QTimer(self)
        self._start_timer.setSingleShot(True)
        self._start_timer.setTimerType(Qt.TimerType.PreciseTimer)
        self._start_timer.timeout.connect(self._finish_countdown)
        self._countdown_timer = QTimer(self)
        self._countdown_timer.setInterval(20)
        self._countdown_timer.timeout.connect(self.countdownChanged)
        self._transfer_timer = QTimer(self)
        self._transfer_timer.setSingleShot(True)
        self._transfer_timer.setInterval(5000)
        self._transfer_timer.timeout.connect(self._on_transfer_timeout)

        # Duplicate-room probe: before claiming host we listen briefly for an
        # existing host on the same room topic.
        self._probe_timer = QTimer(self)
        self._probe_timer.setSingleShot(True)
        self._probe_timer.setInterval(1800)
        self._probe_timer.timeout.connect(self._on_probe_timeout)
        self._probing = False
        self._wants_host = False
        self._pending_room_code = ""
        self._pending_password = ""

        # UI refresh timer drives the seek bar / time labels from the player.
        self._ui_timer = QTimer(self)
        self._ui_timer.setInterval(250)
        self._ui_timer.timeout.connect(self._refresh_playback)
        self._preferences_signature = self._player_preferences()
        if settings is not None:
            settings.changed.connect(self._on_preferences_changed)
            settings.errorOccurred.connect(self.errorOccurred)

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
    def username(self) -> str:
        return (self._settings.values["username"] or "Guest") if self._settings is not None else "Guest"

    @Property(QObject, constant=True)
    def participants(self) -> ParticipantsModel:
        return self._participants

    @Property(bool, notify=changed)
    def selfReady(self) -> bool:
        return self._self_ready

    @Property(bool, notify=changed)
    def selfIgnored(self) -> bool:
        member = self._roster.members.get(self._self_id)
        return member.ignored if member is not None else False

    @Property(bool, notify=changed)
    def canReady(self) -> bool:
        return self._connected and not self._media_preparing and not self._transfer_target and not self.selfIgnored and not self._host_lost and self._self_loaded()

    @Property(str, notify=changed)
    def roomCode(self) -> str:
        return self._pending_room_code

    @Property(str, notify=changed)
    def phase(self) -> str:
        return self._state.phase

    @Property(bool, notify=changed)
    def transferring(self) -> bool:
        return bool(self._transfer_target)

    @Property(int, notify=changed)
    def readyCount(self) -> int:
        return sum(member.ready for member in self._roster.members.values() if not member.ignored and member.participating)

    @Property(int, notify=changed)
    def requiredCount(self) -> int:
        return sum(not member.ignored and member.participating for member in self._roster.members.values())

    @Property(float, notify=countdownChanged)
    def countdownRemaining(self) -> float:
        return max(0.0, self._deadline - time.monotonic()) if self._deadline else 0.0

    @Property(bool, notify=changed)
    def syncLoading(self) -> bool:
        return self.hasMedia and not self._is_host and not self._clock.valid and bool(self._state.host_id)

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
        return True

    @Property(bool, notify=changed)
    def allowSeek(self) -> bool:
        return self._state.options.allow_seek

    @Property(str, notify=changed)
    def playerKey(self) -> str:
        return self._player_key

    @Property(bool, notify=changed)
    def playerLoading(self) -> bool:
        return self._player_loading or self._media_preparing

    @Property(bool, notify=changed)
    def mediaPreparing(self) -> bool:
        return self._media_preparing

    @Property(str, notify=changed)
    def playerError(self) -> str:
        return self._player_error

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
            ("mpv", MpvExternalPlayer.label, MpvExternalPlayer.is_available(self._player_path("mpv"))),
            ("vlc", VlcExternalPlayer.label, VlcExternalPlayer.is_available(self._player_path("vlc"))),
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

        self._wants_host = as_host
        self._is_host = False
        self._probing = False
        self._pending_room_code = room_code
        self._pending_password = password
        self._state = RoomState(options=RoomOptions())
        self._roster = Roster()
        self._clock = ClockSync()
        self._self_ready = False
        self._loaded_last = False
        self._applied_revision = -1
        self._host_lost = False
        self._version_warned = False
        self._member_sequence = 0
        self._update_participants()
        self._set_status("Checking room…" if as_host else "Connecting…")

        self._channel = RoomChannel(room_code, password, self)
        self._channel.message_received.connect(self._on_message)
        self._channel.connected.connect(self._on_channel_connected)
        self._channel.disconnected.connect(self._on_channel_disconnected)
        self._channel.start()

        # Ensure a player is selected.
        if self._player is None:
            self._select_player_internal(self._player_key)
        self._notify()

    @Slot()
    def joinExisting(self) -> None:
        """Join the already-hosted room detected during a host probe (as peer)."""
        self.startRoom(self._pending_room_code, self._pending_password, False)

    @Slot(str)
    def shareFile(self, path: str) -> None:
        if not self._is_host:
            return
        path = self._normalize_path(path)
        if not path or not os.path.isfile(path):
            self.errorOccurred.emit(f"File not found: {path}")
            return
        if self._preparation_stop is not None:
            self._preparation_stop.set()
        self._preparation += 1
        token = self._preparation
        stopped = threading.Event()
        self._preparation_stop = stopped
        self._media_preparing = True
        self._set_self_ready(False)
        self._set_status("Preparing video...")
        self._notify()

        def prepare() -> None:
            try:
                metadata = prepare_file_isolated(path, stopped)
                error = ""
            except Exception as exc:
                metadata = b""
                error = str(exc)
            if not stopped.is_set():
                self._seed_finished.emit(token, path, metadata, error)

        threading.Thread(target=prepare, name="watchalong-file-preparation", daemon=True).start()

    @Slot(int, str, bytes, str)
    def _on_seed_finished(self, token: int, path: str, metadata: bytes, error: str) -> None:
        if token != self._preparation or not self._connected or not self._is_host:
            return
        self._preparation_stop = None
        self._media_preparing = False
        if error:
            self._set_status("Could not prepare video")
            self.errorOccurred.emit(f"Failed to share file: {error}")
            self._notify()
            return
        try:
            magnet = self._engine.seed_prepared(path, metadata)
        except Exception as exc:  # pragma: no cover
            self.errorOccurred.emit(f"Failed to share file: {exc}")
            self._notify()
            return
        self._state.media_magnet = magnet
        self._state.media_id = os.urandom(8).hex()
        self._state.media_name = os.path.basename(path)
        self._state.playing = False
        self._state.phase = "paused"
        self._state.position = 0.0
        self._state.start_at = 0.0
        self._state.revision += 1
        self._cancel_countdown()
        self._self_ready = False
        self._roster.reset_media()
        self._media_token += 1
        self._set_status(f"Sharing: {self._state.media_name}")
        self._load_current_player()
        self._broadcast_set_media()
        self._broadcast_state()
        self._notify()

    @Slot(str)
    def selectPlayer(self, key: str) -> None:
        self._select_player_internal(key)
        if self._settings is not None and self._player_key == key and self._settings.values["defaultPlayer"] != key:
            self._settings.save({"defaultPlayer": key}, False)
        self._notify()

    @Slot()
    def retryPlayer(self) -> None:
        self._load_current_player(self._local_position)

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
        self._set_self_ready(True)

    @Slot()
    def pausePressed(self) -> None:
        self._set_self_ready(False)

    @Slot()
    def toggleReady(self) -> None:
        self._set_self_ready(not self._self_ready)

    @Slot(float)
    def seekTo(self, seconds: float) -> None:
        if not self._can_control_seek() or not protocol.number(seconds, 604_800):
            return
        duration = self._current_duration()
        target = min(seconds, duration) if duration > 0 else seconds
        if self._is_host:
            self._pause_authoritative(target)
            self._evaluate_readiness()
        else:
            self._member_sequence += 1
            self._publish(protocol.SEEK, position=target, seq=self._member_sequence)

    @Slot(bool, bool)
    def setOptions(self, allow_pause: bool, allow_seek: bool) -> None:
        if not self._is_host:
            return
        self._state.options = RoomOptions(allow_seek=allow_seek)
        self._state.revision += 1
        self._broadcast_state()
        self._notify()

    @Slot(str, bool)
    def setIgnored(self, peer_id: str, ignored: bool) -> None:
        member = self._roster.members.get(peer_id)
        if not self._is_host or member is None or peer_id == self._self_id:
            return
        member.ignored = ignored
        member.ready = False
        self._update_participants()
        self._evaluate_readiness()
        self._broadcast_state()

    @Slot(str)
    def kick(self, peer_id: str) -> None:
        if not self._is_host or peer_id == self._self_id or peer_id not in self._roster.members:
            return
        self._roster.bans.add(peer_id)
        del self._roster.members[peer_id]
        self._publish(protocol.KICK, target=peer_id)
        self._update_participants()
        self._evaluate_readiness()
        self._broadcast_state()

    @Slot(str)
    def transferHost(self, peer_id: str) -> None:
        member = self._roster.members.get(peer_id)
        if not self._is_host or self._media_preparing or self._transfer_target or member is None or not member.loaded or member.ignored or peer_id == self._self_id:
            return
        self._pause_authoritative()
        self._transfer_target = peer_id
        snapshot = self._state.to_dict()
        snapshot["members"] = self._roster.records(self._self_id)
        snapshot["bans"] = sorted(self._roster.bans)
        self._expected_transfer = {"target": peer_id, "snapshot": snapshot}
        self._publish(protocol.HOST_TRANSFER, target=peer_id, snapshot=snapshot)
        self._transfer_timer.start()
        self._notify()

    @Slot()
    def leave(self) -> None:
        self._preparation += 1
        if self._preparation_stop is not None:
            self._preparation_stop.set()
            self._preparation_stop = None
        self._media_preparing = False
        if self._channel is not None:
            self._publish(protocol.ROOM_CLOSED if self._is_host else protocol.LEAVE)
            self._channel.stop()
            self._channel = None
        self._heartbeat.stop()
        self._ui_timer.stop()
        self._probe_timer.stop()
        self._transfer_timer.stop()
        self._cancel_countdown()
        if self._player is not None:
            self._player.pause()
        self._self_ready = False
        self._transfer_target = ""
        self._expected_transfer = {}
        self._roster = Roster()
        self._update_participants()
        self._probing = False
        self._wants_host = False
        self._connected = False
        self._is_host = False
        self._position = 0.0
        self._duration = 0.0
        self._player_loading = False
        self._player_error = ""
        self._set_status("Not connected")
        self._notify()

    # --- player management ---------------------------------------------------

    def _player_path(self, key: str) -> str:
        return self._settings.values.get(key + "Path", "") if self._settings is not None else ""

    def _player_preferences(self) -> tuple:
        if self._settings is None:
            return ()
        values = self._settings.values
        return values["defaultPlayer"], values["mpvPath"], values["vlcPath"]

    def _on_preferences_changed(self) -> None:
        signature = self._player_preferences()
        if signature != self._preferences_signature:
            previous = self._preferences_signature
            self._preferences_signature = signature
            key = signature[0]
            if previous[1:] != signature[1:]:
                self._external = {}
            self._select_player_internal(key)
        self._notify()

    def _get_player(self, key: str) -> Optional[Player]:
        if key == "builtin":
            return self._builtin
        if key not in self._external:
            if key == "mpv":
                self._external[key] = MpvExternalPlayer(self._player_path(key))
            elif key == "vlc":
                self._external[key] = VlcExternalPlayer(self._player_path(key))
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
        if previous is new_player:
            return
        path = self._player_path(key)
        available = new_player.is_available(path) if path else new_player.is_available()
        if not available:
            self.errorOccurred.emit(f"Player '{key}' is not available")
            return
        handoff_position = self._current_position()
        if previous is not None and previous is not new_player and previous is not self._builtin:
            previous.shutdown()
        elif previous is self._builtin and previous is not new_player and previous is not None:
            previous.pause()

        self._player = new_player
        self._player_key = key
        self._player_error = ""
        self._local_position = handoff_position
        self._player.set_position_callback(self._on_local_position)
        self._player.set_volume(self._volume)
        if self._state.media_magnet and self._stream.url:
            if self._connected:
                self._set_self_ready(False)
            self._load_current_player(handoff_position)

    def _load_current_player(self, position: float | None = None) -> None:
        if self._player is None or not self._stream.url:
            return
        self._player_error = ""
        self._player_loading = True
        self._loaded_last = False
        self._notify()
        # Cache-busting token forces a genuine reload when the media changes.
        try:
            self._player.load(f"{self._stream.url}?v={self._media_token}")
            self._player.set_volume(self._volume)
            target = self._state.position if position is None else position
            self._local_position = target
            if target > 0:
                self._player.seek(target)
            self._player.set_paused(not self._state.playing)
        except Exception as exc:
            self._player_error = str(exc)
            self._player_loading = False
            self.errorOccurred.emit(f"Failed to load player: {exc}")
            self._notify()
        self._ui_timer.start()

    def _on_local_position(self, seconds: float) -> None:
        if self._player is not None and self._player.is_loaded():
            self._local_position = seconds

    def _current_position(self) -> float:
        if self._player is not None and self._player.is_loaded():
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
        if self._player is not None:
            error = self._player.get_error()
            if error and error != self._player_error:
                self._player_error = error
                self._player_loading = False
                self.errorOccurred.emit(f"{self._player.label}: {error}")
                self._set_self_ready(False)
                self._notify()
            elif self._player_loading and self._player.is_loaded():
                self._player_loading = False
                self._notify()
        position = self._current_position()
        duration = self._current_duration()
        self._local_position = position
        if position != self._position or duration != self._duration:
            self._position = position
            self._duration = duration
            self.positionChanged.emit()

        loaded = self._self_loaded()
        if loaded != self._loaded_last:
            self._loaded_last = loaded
            if loaded and not self._is_host and self._state.phase == "playing":
                self._apply_timeline(force=True)
            self._send_member()
            self._notify()

    # --- playback commands ---------------------------------------------------

    def _self_loaded(self) -> bool:
        return bool(self.hasMedia and self._player is not None and self._player.is_loaded()
                    and not self._player_error and (self._is_host or self._clock.valid))

    def _publish(self, kind: str, **fields) -> None:
        if self._channel is not None:
            payload = {"session": self._state.session, "term": self._state.term}
            payload.update(fields)
            self._channel.publish(protocol.make(kind, self._self_id, **payload))

    def _set_self_ready(self, ready: bool) -> None:
        if ready and not self.canReady:
            return
        if self.selfIgnored:
            return
        self._self_ready = ready
        self._send_member()
        self._notify()

    def _send_member(self) -> None:
        if not self._connected:
            return
        self._member_sequence += 1
        loaded = self._self_loaded()
        if self._is_host:
            self._roster.announce(self._self_id, self.username, time.monotonic(), self._instance)
            self._roster.update(self._self_id, self._self_ready, loaded,
                                self._member_sequence, time.monotonic(), self.username)
            self._update_participants()
            self._evaluate_readiness()
        else:
            member = self._roster.members.get(self._self_id)
            if member is not None and not member.participating and loaded and not member.ignored:
                self._self_ready = True
            self._publish(protocol.MEMBER, username=self.username, instance=self._instance,
                          ready=self._self_ready, loaded=loaded, seq=self._member_sequence,
                          media_id=self._state.media_id)

    def _update_participants(self) -> None:
        self._participants.update(self._roster.records(self._state.host_id, self._self_id))
        self._notify()

    def _host_time(self) -> float:
        return time.time() if self._is_host else self._clock.to_host(time.time())

    def _target_position(self) -> float:
        elapsed = max(0.0, self._host_time() - self._state.anchor_ts) if self._state.phase == "playing" else 0.0
        return self._state.position + elapsed

    def _evaluate_readiness(self) -> None:
        if not self._is_host or not self.hasMedia or self._transfer_target:
            return
        if not self._roster.all_ready:
            if self._state.phase in ("playing", "countdown"):
                self._pause_authoritative()
            return
        if self._state.phase == "paused":
            self._state.phase = "countdown"
            self._state.playing = False
            self._state.start_at = time.time() + 3.0
            self._state.anchor_ts = self._state.start_at
            self._state.revision += 1
            self._apply_timeline(force=True)
            self._publish(protocol.PLAY_AT, **self._state.to_dict(), members=self._roster.records(self._self_id))
            self._broadcast_state()
            self._notify()

    def _pause_authoritative(self, position: float | None = None) -> None:
        if not self._is_host:
            return
        target = self._current_position() if position is None else position
        self._state.phase = "paused"
        self._state.playing = False
        self._state.position = max(0.0, target)
        self._state.start_at = 0.0
        self._state.anchor_ts = time.time()
        self._state.revision += 1
        self._apply_timeline(force=True)
        self._publish(protocol.PAUSE, **self._state.to_dict(), members=self._roster.records(self._self_id))
        self._broadcast_state()
        self._notify()

    def _cancel_countdown(self) -> None:
        self._start_timer.stop()
        self._countdown_timer.stop()
        self._deadline = 0.0
        self.countdownChanged.emit()

    def _apply_timeline(self, force: bool = False) -> None:
        if not self.hasMedia:
            return
        target = self._target_position()
        self._local_position = target
        if self._state.phase == "countdown":
            if self._player is not None:
                self._player.pause()
                if force:
                    self._player.seek(self._state.position)
            if (self._is_host or self._clock.valid) and (force or not self._deadline):
                remaining = max(0.0, self._state.start_at - self._host_time())
                self._deadline = time.monotonic() + remaining
                self._start_timer.start(max(1, int(remaining * 1000)))
                self._countdown_timer.start()
                self.countdownChanged.emit()
            return
        self._cancel_countdown()
        if self._player is not None:
            if self._state.phase == "paused":
                self._player.pause()
            if force or abs(self._current_position() - target) > (_DRIFT_THRESHOLD if self._state.playing else 0.05):
                self._player.seek(target)
            if self._state.playing and (self._is_host or self._clock.valid):
                self._player.play()

    def _finish_countdown(self) -> None:
        if self._state.phase != "countdown" or self._host_lost:
            self._cancel_countdown()
            return
        if self.countdownRemaining > 0.001:
            self._start_timer.start(max(1, int(self.countdownRemaining * 1000)))
            return
        if self._is_host and not self._roster.all_ready:
            self._pause_authoritative()
            return
        self._state.phase = "playing"
        self._state.playing = True
        self._state.anchor_ts = self._state.start_at
        self._cancel_countdown()
        self._apply_timeline()
        if self._is_host:
            self._state.revision += 1
            self._broadcast_state()
        self._notify()

    def _send_ping(self) -> None:
        if self._is_host or not self._state.host_id:
            return
        now = time.time()
        self._pings = {stamp: sent for stamp, sent in self._pings.items() if now - sent < 10}
        self._pings[now] = now
        self._publish(protocol.PING, target=self._state.host_id, t0=now)

    def _on_transfer_timeout(self) -> None:
        self._transfer_target = ""
        self._expected_transfer = {}
        self.errorOccurred.emit("Host transfer was not acknowledged; you are still hosting")
        self._evaluate_readiness()
        self._broadcast_state()
        self._notify()

    # --- broadcasting (host) -------------------------------------------------

    def _broadcast_set_media(self) -> None:
        if self._channel is None or not self._state.media_magnet:
            return
        self._publish(protocol.SET_MEDIA, **self._state.to_dict(), meta=self._engine.torrent_file_b64())

    def _broadcast_state(self) -> None:
        if self._channel is None or not self._is_host:
            return
        self._publish(protocol.STATE, **self._state.to_dict(), members=self._roster.records(self._self_id))

    def _send_heartbeat(self) -> None:
        if not self._connected:
            return
        self._ticks += 1
        self._send_member()
        if self._is_host:
            if self._transfer_target:
                self._publish(protocol.HOST_TRANSFER, **self._expected_transfer)
            if time.monotonic() < self._claim_until:
                self._publish(protocol.HOST_CLAIM, host_id=self._self_id)
            if self._roster.expire(time.monotonic(), self._self_id):
                self._update_participants()
                self._evaluate_readiness()
            self._broadcast_state()
        else:
            if not self._state.host_id:
                self._publish(protocol.HELLO, username=self.username, instance=self._instance)
            if not self._clock.valid or self._ticks % 15 == 0:
                self._send_ping()
            if self._state.host_id and time.monotonic() - self._host_seen > 12 and not self._host_lost:
                self._host_lost = True
                self._self_ready = False
                self._cancel_countdown()
                if self._player is not None:
                    self._player.pause()
                self._set_status("Host disconnected; playback paused")
                self._notify()

    # --- incoming messages ---------------------------------------------------

    def _on_message(self, message: dict) -> None:
        source = self.sender()
        if source is not None and source is not self._channel:
            return
        if not isinstance(message, dict):
            return
        sender = message.get("from")
        if sender == self._self_id:
            return
        msg_type = message.get("t")
        if message.get("v") != protocol.VERSION:
            if not self._version_warned and msg_type in (protocol.STATE, protocol.HOST_ACK):
                self._version_warned = True
                self._probe_timer.stop()
                self._probing = False
                self.errorOccurred.emit("Incompatible room version. All participants must update Watchalong.")
            return
        if not protocol.validate(message):
            return

        if self._probing:
            # While probing we only care whether a host already owns the room.
            if msg_type in (protocol.HOST_ACK, protocol.STATE, protocol.SET_MEDIA):
                self._on_existing_room_detected()
            return
        if msg_type == protocol.PROBE:
            if self._is_host and self._channel is not None:
                self._publish(protocol.HOST_ACK, host_id=self._self_id)
            return
        if msg_type == protocol.HOST_ACK:
            if not self._is_host and (not self._state.host_id or sender == self._state.host_id):
                if not protocol.identifier(message.get("session")):
                    return
                self._state.host_id = sender
                self._state.session = message["session"]
                self._state.term = message.get("term", 1)
                self._host_seen = time.monotonic()
                self._send_ping()
                self._publish(protocol.REQUEST_STATE)
            return

        if msg_type == protocol.HELLO:
            if self._is_host:
                self._publish(protocol.HOST_ACK, host_id=self._self_id)
                member = self._roster.announce(sender, message.get("username", "Guest"), time.monotonic(),
                    message.get("instance", ""), late=self._state.phase in ("playing", "countdown"))
                if member is None:
                    self._publish(protocol.KICK, target=sender)
                    return
                self._update_participants()
                self._broadcast_set_media()
                self._broadcast_state()
            return
        if not self._is_host and not self._state.host_id and msg_type == protocol.STATE:
            try:
                initial = RoomState.from_dict(message)
            except (ValueError, KeyError, TypeError):
                return
            if initial.host_id != sender:
                return
            self._state.host_id = sender
            self._state.session = initial.session
            self._state.term = initial.term
            self._send_ping()
        if message.get("session") != self._state.session or message.get("term") != self._state.term:
            if msg_type == protocol.HOST_CLAIM:
                self._handle_host_claim(message)
            return
        if msg_type == protocol.PING:
            if self._is_host and message.get("target") == self._self_id and protocol.number(message.get("t0")):
                received = time.time()
                self._publish(protocol.PONG, target=sender, t0=message["t0"], t1=received, t2=time.time())
            return
        if msg_type == protocol.PONG:
            stamp = message.get("t0")
            if sender == self._state.host_id and message.get("target") == self._self_id and stamp in self._pings:
                self._pings.pop(stamp)
                if protocol.number(message.get("t1")) and protocol.number(message.get("t2")):
                    if self._clock.sample(stamp, message["t1"], message["t2"], time.time()):
                        self._apply_timeline()
                        self._send_member()
                        self._notify()
            return
        if msg_type == protocol.MEMBER:
            if self._is_host:
                member = self._roster.members.get(sender)
                if member is None or member.instance != message.get("instance", ""):
                    return
                if member.ignored:
                    member.last_seen = time.monotonic()
                    member.sequence = max(member.sequence, message.get("seq", -1))
                    return
                loaded = message.get("loaded") is True and message.get("media_id") == self._state.media_id
                if self._roster.update(sender, message.get("ready") is True, loaded,
                                       message.get("seq", -1), time.monotonic(), message.get("username", member.name)):
                    self._update_participants()
                    self._evaluate_readiness()
                    self._broadcast_state()
            return
        if msg_type == protocol.LEAVE:
            if self._is_host and sender in self._roster.members:
                del self._roster.members[sender]
                self._update_participants()
                self._evaluate_readiness()
                self._broadcast_state()
            return
        if msg_type == protocol.REQUEST_STATE:
            if self._is_host:
                self._broadcast_set_media()
                self._broadcast_state()
            return
        if msg_type == protocol.SEEK:
            self._handle_control_request(message)
            return
        if sender != self._state.host_id or self._is_host:
            return
        self._host_seen = time.monotonic()
        self._host_lost = False
        if msg_type == protocol.SET_MEDIA:
            if message.get("revision", -1) >= self._applied_revision:
                self._handle_set_media(message)
        elif msg_type in (protocol.STATE, protocol.PLAY_AT, protocol.PAUSE):
            self._handle_host_state(message)
        elif msg_type == protocol.KICK and message.get("target") == self._self_id:
            self.leave()
            self._set_status("Removed by the host")
            self.errorOccurred.emit("You were removed by the host")
        elif msg_type == protocol.ROOM_CLOSED:
            self.leave()
            self._set_status("The host closed the room")
        elif msg_type == protocol.HOST_TRANSFER:
            self._handle_transfer_offer(message)

    def _handle_set_media(self, message: dict) -> None:
        magnet = message.get("magnet", "")
        if not magnet:
            return
        meta = message.get("meta", "")
        same = magnet == self._state.media_magnet
        # Nothing to do if we already have this media and its metadata resolved.
        # If we only had the magnet (slow path) and a metadata blob just arrived,
        # upgrade to the fast path so the download can actually start.
        if same and (not meta or self._engine.has_metadata()):
            return
        self._state.media_magnet = magnet
        self._state.media_id = message.get("media_id", self._state.media_id)
        self._state.media_name = message.get("name", "")
        if not same:
            self._state.position = 0.0
            self._state.playing = False
            self._state.phase = "paused"
            self._self_ready = False
            self._cancel_countdown()
            self._media_token += 1
        self._set_status(f"Loading: {self._state.media_name}")
        try:
            if meta:
                self._engine.add_torrent_metadata(meta)
            else:
                self._engine.add_magnet(magnet)
        except Exception as exc:  # pragma: no cover
            self.errorOccurred.emit(f"Failed to load shared media: {exc}")
        self._notify()

    def _handle_host_state(self, message: dict) -> None:
        try:
            incoming = RoomState.from_dict(message)
            roster = Roster()
            roster.replace(message.get("members", []))
        except (ValueError, TypeError, KeyError):
            return
        if incoming.host_id != message.get("from") or incoming.revision < self._applied_revision:
            return
        changed = incoming.revision != self._applied_revision
        old_phase = self._state.phase
        if incoming.media_magnet and incoming.media_id != self._state.media_id:
            self._handle_set_media(message)
        self._state = incoming
        self._applied_revision = incoming.revision
        self._roster = roster
        member = roster.members.get(self._self_id)
        if member is not None and (member.ignored or member.sequence >= self._member_sequence):
            self._self_ready = member.ready and not member.ignored
        self._update_participants()
        self._apply_timeline(force=changed and not (old_phase == "playing" and incoming.phase == "playing"))
        self._set_status("Connected to host")
        self._notify()

    def _handle_control_request(self, message: dict) -> None:
        if not self._is_host:
            return
        member = self._roster.members.get(message.get("from"))
        if member is None or member.ignored or not self._state.options.allow_seek or self._transfer_target:
            return
        sequence = message.get("seq", -1)
        if sequence <= member.sequence or not protocol.number(message.get("position"), 604_800):
            return
        member.sequence = sequence
        self.seekTo(float(message["position"]))

    def _handle_transfer_offer(self, message: dict) -> None:
        target = message.get("target")
        snapshot = message.get("snapshot")
        try:
            state = RoomState.from_dict(snapshot)
            roster = Roster()
            roster.replace(snapshot["members"])
            bans = snapshot.get("bans", [])
            if not isinstance(bans, list) or len(bans) > 256 or not all(protocol.identifier(peer) for peer in bans):
                return
            if target not in roster.members or state.host_id != self._state.host_id or state.session != self._state.session or state.term != self._state.term:
                return
        except (ValueError, TypeError, KeyError, AttributeError):
            return
        self._expected_transfer = {"target": target, "snapshot": snapshot}
        if target == self._self_id:
            self._state = state
            self._state.host_id = self._self_id
            self._state.term += 1
            self._state.revision += 1
            self._is_host = True
            self._claim_until = time.monotonic() + 6
            self._roster = roster
            self._roster.bans = set(bans)
            for member in roster.members.values():
                member.last_seen = time.monotonic()
            self._clock = ClockSync()
            self._publish(protocol.HOST_CLAIM, host_id=self._self_id)
            self._update_participants()
            self._evaluate_readiness()
            self._broadcast_state()
            self._notify()

    def _handle_host_claim(self, message: dict) -> None:
        target = self._expected_transfer.get("target")
        if not target or message.get("from") != target or message.get("session") != self._state.session or message.get("term") != self._state.term + 1:
            return
        self._transfer_timer.stop()
        self._transfer_target = ""
        self._expected_transfer = {}
        self._is_host = False
        self._state.host_id = target
        self._state.term = message["term"]
        self._state.phase = "paused"
        self._state.playing = False
        self._applied_revision = -1
        self._clock = ClockSync()
        self._cancel_countdown()
        self._send_ping()
        self._publish(protocol.REQUEST_STATE)
        self._update_participants()

    # --- signal handlers -----------------------------------------------------

    def _on_channel_connected(self) -> None:
        if self.sender() is not None and self.sender() is not self._channel:
            return
        if self._wants_host and not self._is_host:
            # Probe for an existing host before claiming the room.
            self._probing = True
            self._set_status("Checking room…")
            if self._channel is not None:
                self._channel.publish(protocol.make(protocol.PROBE, self._self_id))
            self._probe_timer.start()
            self._notify()
            return
        self._connected = True
        self._heartbeat.start()
        self._set_status("Connected" if not self._is_host else "Hosting — share a file")
        if self._is_host:
            self._heartbeat.start()
            if self._channel is not None:
                self._publish(protocol.HOST_ACK, host_id=self._self_id)
        else:
            if self._channel is not None:
                self._publish(protocol.HELLO, username=self.username, instance=self._instance)
                self._publish(protocol.REQUEST_STATE)
        self._notify()

    def _on_probe_timeout(self) -> None:
        if not self._probing:
            return
        # No existing host answered: claim the room.
        self._probing = False
        self._wants_host = False
        self._is_host = True
        self._state.host_id = self._self_id
        self._state.session = os.urandom(16).hex()
        self._connected = True
        self._set_status("Hosting — share a file")
        self._heartbeat.start()
        if self._channel is not None:
            self._publish(protocol.HOST_ACK, host_id=self._self_id)
        self._roster.announce(self._self_id, self.username, time.monotonic(), self._instance)
        self._update_participants()
        self._notify()

    def _on_existing_room_detected(self) -> None:
        if not self._probing:
            return
        self._probing = False
        self._wants_host = False
        self._probe_timer.stop()
        room_code = self._pending_room_code
        if self._channel is not None:
            self._channel.stop()
            self._channel = None
        self._set_status("Not connected")
        self.roomExists.emit(room_code)
        self._notify()

    def _on_channel_disconnected(self) -> None:
        if self.sender() is not None and self.sender() is not self._channel:
            return
        self._connected = False
        self._self_ready = False
        self._cancel_countdown()
        if self._player is not None:
            self._player.pause()
        if self._is_host:
            self._state.phase = "paused"
            self._state.playing = False
            self._state.position = self._current_position()
            self._state.revision += 1
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
        return self.canReady

    def _can_control_seek(self) -> bool:
        return self.hasMedia and not self.selfIgnored and not self._transfer_target and (self._is_host or self._state.options.allow_seek)

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
        if self._player is not None:
            self._player.shutdown()
        for player in self._external.values():
            player.shutdown()
        self._builtin.shutdown()
        self._stream.stop()
        self._engine.shutdown()
