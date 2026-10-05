"""Versioned, host-authoritative room messages."""

from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass, field
from typing import Any

VERSION = 2
HELLO = "hello"
MEMBER = "member"
LEAVE = "leave"
STATE = "state"
SET_MEDIA = "set_media"
PLAY_AT = "play_at"
PAUSE = "pause"
SEEK = "seek_request"
OPTIONS = "options"
REQUEST_STATE = "request_state"
PROBE = "probe"
HOST_ACK = "host_ack"
PING = "ping"
PONG = "pong"
KICK = "kick"
HOST_TRANSFER = "host_transfer"
HOST_CLAIM = "host_claim"
ROOM_CLOSED = "room_closed"
TYPES = {HELLO, MEMBER, LEAVE, STATE, SET_MEDIA, PLAY_AT, PAUSE, SEEK, OPTIONS,
         REQUEST_STATE, PROBE, HOST_ACK, PING, PONG, KICK, HOST_TRANSFER, HOST_CLAIM, ROOM_CLOSED}


def identifier(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value) is not None


def number(value: object, maximum: float = 31_557_600_000.0) -> bool:
    return not isinstance(value, bool) and isinstance(value, (float, int)) and math.isfinite(value) and 0 <= value <= maximum


def validate(message: object) -> bool:
    if not isinstance(message, dict) or message.get("v") != VERSION:
        return False
    if not isinstance(message.get("t"), str) or message["t"] not in TYPES or not identifier(message.get("from")) or not number(message.get("ts")):
        return False
    for key in ("position", "anchor_ts", "start_at", "t0", "t1", "t2"):
        if key in message and not number(message[key], 604_800.0 if key == "position" else 31_557_600_000.0):
            return False
    for key in ("seq", "revision", "term"):
        if key in message and (type(message[key]) is not int or not 0 <= message[key] <= 2**53):
            return False
    for key in ("ready", "loaded", "playing"):
        if key in message and not isinstance(message[key], bool):
            return False
    for key in ("target", "host_id", "session", "instance", "media_id"):
        if key in message and message[key] != "" and not identifier(message[key]):
            return False
    for key, limit in (("name", 512), ("username", 24), ("magnet", 16_384), ("meta", 2_097_152)):
        if key in message and (not isinstance(message[key], str) or len(message[key]) > limit):
            return False
    if "options" in message and not isinstance(message["options"], dict):
        return False
    if "members" in message and (not isinstance(message["members"], list) or len(message["members"]) > 256):
        return False
    return True


def make(type_: str, sender: str, **fields: Any) -> dict[str, Any]:
    message = {"v": VERSION, "t": type_, "from": sender, "ts": time.time()}
    message.update(fields)
    return message


@dataclass
class RoomOptions:
    allow_seek: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {"allow_seek": self.allow_seek}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RoomOptions":
        return cls(
            allow_seek=data.get("allow_seek") is True,
        )


@dataclass
class RoomState:
    host_id: str = ""
    session: str = ""
    term: int = 1
    revision: int = 0
    media_id: str = ""
    media_magnet: str = ""
    media_name: str = ""
    playing: bool = False
    phase: str = "paused"
    position: float = 0.0
    anchor_ts: float = 0.0
    start_at: float = 0.0
    options: RoomOptions = field(default_factory=RoomOptions)

    def to_dict(self) -> dict:
        return {"host_id": self.host_id, "session": self.session, "term": self.term,
                "revision": self.revision, "media_id": self.media_id, "magnet": self.media_magnet,
                "name": self.media_name, "playing": self.playing, "phase": self.phase,
                "position": self.position, "anchor_ts": self.anchor_ts, "start_at": self.start_at,
                "options": self.options.to_dict()}

    @classmethod
    def from_dict(cls, data: dict) -> "RoomState":
        if data.get("phase") not in ("paused", "countdown", "playing"):
            raise ValueError("Invalid playback phase")
        if not identifier(data.get("host_id")) or not identifier(data.get("session")):
            raise ValueError("Invalid room authority")
        for key in ("term", "revision"):
            if type(data.get(key)) is not int or not 0 <= data[key] <= 2**53:
                raise ValueError("Invalid state revision")
        for key in ("position", "anchor_ts", "start_at"):
            if not number(data.get(key), 604_800.0 if key == "position" else 31_557_600_000.0):
                raise ValueError("Invalid playback timestamp")
        if not isinstance(data.get("magnet", ""), str) or len(data.get("magnet", "")) > 16_384:
            raise ValueError("Invalid media magnet")
        if not isinstance(data.get("name", ""), str) or len(data.get("name", "")) > 512:
            raise ValueError("Invalid media name")
        media_id = data.get("media_id", "")
        if media_id and not identifier(media_id):
            raise ValueError("Invalid media identity")
        if not isinstance(data.get("options", {}), dict):
            raise ValueError("Invalid room options")
        return cls(host_id=data["host_id"], session=data["session"], term=data["term"],
                   revision=data["revision"], media_id=media_id, media_magnet=data.get("magnet", ""),
                   media_name=data.get("name", ""), playing=data["phase"] == "playing",
                   phase=data["phase"], position=float(data["position"]), anchor_ts=float(data["anchor_ts"]),
                   start_at=float(data["start_at"]), options=RoomOptions.from_dict(data.get("options", {})))
