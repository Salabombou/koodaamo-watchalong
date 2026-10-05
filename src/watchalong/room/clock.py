from __future__ import annotations

import math
from collections import deque


class ClockSync:
    def __init__(self) -> None:
        self._samples: deque[tuple[float, float]] = deque(maxlen=8)

    @property
    def valid(self) -> bool:
        return bool(self._samples)

    @property
    def offset(self) -> float:
        return min(self._samples, key=lambda sample: sample[0])[1] if self._samples else 0.0

    def sample(self, local_send: float, host_receive: float, host_send: float, local_receive: float) -> bool:
        values = (local_send, host_receive, host_send, local_receive)
        if not all(math.isfinite(value) for value in values):
            return False
        if local_receive < local_send or host_send < host_receive:
            return False
        roundtrip = (local_receive - local_send) - (host_send - host_receive)
        if not 0 <= roundtrip <= 10:
            return False
        offset = ((host_receive - local_send) + (host_send - local_receive)) / 2
        self._samples.append((roundtrip, offset))
        return True

    def to_host(self, local_time: float) -> float:
        return local_time + self.offset

    def to_local(self, host_time: float) -> float:
        return host_time - self.offset