"""Control-channel message schema and shared room state.

The host is authoritative. Clients apply the host's state and may only send
play/pause/seek requests when the corresponding room option is enabled.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

# --- message types -----------------------------------------------------------

HELLO = "hello"              # announce presence / who is host
STATE = "state"             # host -> clients authoritative heartbeat
SET_MEDIA = "set_media"     # host -> clients new magnet/media selected
PLAY = "play"               # play request/command
PAUSE = "pause"             # pause request/command
SEEK = "seek"               # seek request/command
OPTIONS = "options"         # host -> clients room option change
REQUEST_STATE = "request_state"  # client -> host asks for current state


def make(type_: str, sender: str, **fields: Any) -> dict[str, Any]:
    message = {"t": type_, "from": sender, "ts": time.time()}
    message.update(fields)
    return message


@dataclass
class RoomOptions:
    allow_pause: bool = False
    allow_seek: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {"allow_pause": self.allow_pause, "allow_seek": self.allow_seek}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RoomOptions":
        return cls(
            allow_pause=bool(data.get("allow_pause", False)),
            allow_seek=bool(data.get("allow_seek", False)),
        )


@dataclass
class RoomState:
    host_id: str = ""
    media_magnet: str = ""
    media_name: str = ""
    playing: bool = False
    position: float = 0.0
    updated_at: float = 0.0
    options: RoomOptions = field(default_factory=RoomOptions)
