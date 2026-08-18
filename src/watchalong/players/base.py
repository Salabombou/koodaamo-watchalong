"""Common interface implemented by every player backend."""

from __future__ import annotations

from typing import Callable, Optional


class Player:
    """Abstract media player controlled by the sync layer.

    Implementations wrap the built-in Qt Multimedia player or an external
    process (mpv / VLC). All of them play from the local stream server URL so
    the torrent's peer-to-peer relay keeps working regardless of the choice.
    """

    #: Stable identifier used in the UI and settings.
    key = "base"
    #: Human-readable label.
    label = "Base"

    def __init__(self) -> None:
        self._position_callback: Optional[Callable[[float], None]] = None

    def set_position_callback(self, callback: Callable[[float], None]) -> None:
        self._position_callback = callback

    def _emit_position(self, seconds: float) -> None:
        if self._position_callback is not None:
            self._position_callback(seconds)

    # --- lifecycle -----------------------------------------------------------

    @classmethod
    def is_available(cls) -> bool:
        return True

    def load(self, url: str) -> None:
        raise NotImplementedError

    def play(self) -> None:
        raise NotImplementedError

    def pause(self) -> None:
        raise NotImplementedError

    def set_paused(self, paused: bool) -> None:
        if paused:
            self.pause()
        else:
            self.play()

    def seek(self, seconds: float) -> None:
        raise NotImplementedError

    def get_position(self) -> float:
        return 0.0

    def get_duration(self) -> float:
        return 0.0

    def set_volume(self, percent: float) -> None:
        pass

    def get_volume(self) -> float:
        return 100.0

    def shutdown(self) -> None:
        pass
