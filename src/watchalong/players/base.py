"""Common interface implemented by every player backend."""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Callable, Optional


class _SeekTracker:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._expected: deque[tuple[float, float]] = deque(maxlen=16)
        self._command_events: deque[float] = deque(maxlen=16)
        self._previous: tuple[float, float, bool] | None = None
        self._pending: float | None = None

    def reset(self, position: float | None = None) -> None:
        with self._lock:
            self._expected.clear()
            self._command_events.clear()
            self._previous = None if position is None else (position, time.monotonic(), False)
            self._pending = None

    def expect(self, position: float) -> None:
        with self._lock:
            deadline = time.monotonic() + 3.0
            self._expected.append((position, deadline))
            self._command_events.append(deadline)

    def command_event(self) -> bool:
        with self._lock:
            now = time.monotonic()
            while self._command_events and self._command_events[0] < now:
                self._command_events.popleft()
            if self._command_events:
                self._command_events.popleft()
                return True
            return False

    def observe(self, position: float, playing: bool, explicit: bool = False) -> None:
        with self._lock:
            now = time.monotonic()
            while self._expected and self._expected[0][1] < now:
                self._expected.popleft()
            previous = self._previous
            self._previous = (position, now, playing)
            if not explicit:
                for index, (target, deadline) in enumerate(self._expected):
                    if abs(position - target) <= 0.35:
                        for unused in range(index + 1):
                            self._expected.popleft()
                        return
            if previous is None:
                if explicit:
                    self._pending = position
                return
            old_position, sampled_at, was_playing = previous
            advance = max(0.0, now - sampled_at) if was_playing else 0.0
            tolerance = 0.75 if playing or was_playing else 0.15
            delta = position - old_position
            if explicit or delta < -tolerance or delta > advance + tolerance:
                self._pending = position

    def take(self) -> float | None:
        with self._lock:
            position = self._pending
            self._pending = None
            return position


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

    def unload(self) -> None:
        self.pause()

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

    def is_loaded(self) -> bool:
        return True

    def is_at_end(self) -> bool:
        return False

    def take_seek(self) -> float | None:
        return None

    def get_error(self) -> str:
        return ""

    def set_volume(self, percent: float) -> None:
        pass

    def get_volume(self) -> float:
        return 100.0

    def shutdown(self) -> None:
        pass
