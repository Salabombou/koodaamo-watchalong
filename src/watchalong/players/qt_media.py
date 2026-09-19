"""Built-in media player backed by Qt Multimedia (FFmpeg).

Qt Multimedia ships with PySide6 and bundles the FFmpeg backend since Qt 6.5,
so this player works without any external installation. Video is rendered by a
QML ``VideoOutput`` item handed over via :meth:`set_video_output`; audio is
routed through a :class:`QAudioOutput`.
"""

from __future__ import annotations

import logging

from PySide6.QtCore import QObject, QUrl
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer

from .base import Player

log = logging.getLogger(__name__)


class QtMediaPlayer(Player):
    key = "builtin"
    label = "Built-in"

    def __init__(self) -> None:
        super().__init__()
        self._player = QMediaPlayer()
        self._audio = QAudioOutput()
        self._player.setAudioOutput(self._audio)
        self._player.positionChanged.connect(self._on_position_changed)
        self._player.errorOccurred.connect(self._on_error)
        self._video_item: QObject | None = None

    @classmethod
    def is_available(cls) -> bool:
        # Qt Multimedia is always bundled with PySide6.
        return True

    def set_video_output(self, item: QObject | None) -> None:
        self._video_item = item
        if item is None:
            self._player.setVideoOutput(None)
            return
        sink = item.property("videoSink")
        if sink is not None:
            self._player.setVideoSink(sink)
        else:
            self._player.setVideoOutput(item)

    # --- lifecycle -----------------------------------------------------------

    def load(self, url: str) -> None:
        # Stop and clear first so re-loading a new video (served from the same
        # local URL) always restarts instead of resuming the previous stream.
        self._player.stop()
        self._player.setSource(QUrl(url))
        self._player.play()

    def play(self) -> None:
        self._player.play()

    def pause(self) -> None:
        self._player.pause()

    def set_paused(self, paused: bool) -> None:
        if paused:
            self._player.pause()
        else:
            self._player.play()

    def seek(self, seconds: float) -> None:
        self._player.setPosition(int(max(0.0, seconds) * 1000))

    def get_position(self) -> float:
        return self._player.position() / 1000.0

    def get_duration(self) -> float:
        return self._player.duration() / 1000.0

    def set_volume(self, percent: float) -> None:
        self._audio.setVolume(max(0.0, min(1.0, percent / 100.0)))

    def get_volume(self) -> float:
        return self._audio.volume() * 100.0

    def shutdown(self) -> None:
        self._player.stop()
        self._player.setVideoOutput(None)

    # --- signals -------------------------------------------------------------

    def _on_position_changed(self, ms: int) -> None:
        self._emit_position(ms / 1000.0)

    def _on_error(self, error: QMediaPlayer.Error, error_string: str = "") -> None:
        if error != QMediaPlayer.Error.NoError:
            log.warning("Qt Multimedia player error: %s", error_string or error)
