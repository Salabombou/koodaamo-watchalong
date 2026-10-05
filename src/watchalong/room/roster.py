from __future__ import annotations

from dataclasses import dataclass

from .protocol import identifier


def display_name(value: object) -> str:
    if not isinstance(value, str):
        return "Guest"
    return "".join(character for character in value if character.isprintable()).strip()[:24] or "Guest"


@dataclass
class Member:
    peer_id: str
    name: str
    instance: str = ""
    ready: bool = False
    loaded: bool = False
    ignored: bool = False
    participating: bool = True
    last_seen: float = 0.0
    sequence: int = -1

    def to_dict(self, host_id: str, self_id: str = "") -> dict:
        return {"peerId": self.peer_id, "displayName": self.name, "instance": self.instance,
                "ready": self.ready, "loaded": self.loaded, "ignored": self.ignored,
                "participating": self.participating, "isHost": self.peer_id == host_id,
                "isSelf": self.peer_id == self_id, "sequence": self.sequence}


class Roster:
    def __init__(self) -> None:
        self.members: dict[str, Member] = {}
        self.bans: set[str] = set()

    def announce(self, peer_id: str, name: str, now: float, instance: str = "", late: bool = False) -> Member | None:
        if not identifier(peer_id) or peer_id in self.bans or (peer_id not in self.members and len(self.members) >= 256):
            return None
        member = self.members.get(peer_id)
        if member is None or member.instance != instance:
            ignored = member.ignored if member is not None else False
            member = Member(peer_id, display_name(name), instance, ignored=ignored, participating=not late)
            self.members[peer_id] = member
        member.name = display_name(name)
        member.last_seen = now
        return member

    def update(self, peer_id: str, ready: bool, loaded: bool, sequence: int, now: float, name: str) -> bool:
        member = self.members.get(peer_id)
        if member is None or sequence <= member.sequence:
            return False
        member.sequence = sequence
        member.last_seen = now
        member.name = display_name(name)
        previous = (member.ready, member.loaded, member.participating)
        member.loaded = loaded
        if not member.participating and loaded:
            member.participating = True
            member.ready = not member.ignored
        else:
            member.ready = ready and loaded and not member.ignored
        return previous != (member.ready, member.loaded, member.participating)

    @property
    def all_ready(self) -> bool:
        required = [member for member in self.members.values() if member.participating and not member.ignored]
        return bool(required) and all(member.ready and member.loaded for member in required)

    def expire(self, now: float, host_id: str, timeout: float = 12.0) -> list[str]:
        removed = [peer_id for peer_id, member in self.members.items()
                   if peer_id != host_id and now - member.last_seen > timeout]
        for peer_id in removed:
            del self.members[peer_id]
        return removed

    def reset_media(self) -> None:
        for member in self.members.values():
            member.ready = False
            member.loaded = False
            member.participating = True

    def records(self, host_id: str, self_id: str = "") -> list[dict]:
        return [member.to_dict(host_id, self_id) for member in sorted(
            self.members.values(), key=lambda member: (member.peer_id != host_id, member.name.casefold(), member.peer_id))]

    def replace(self, records: object) -> None:
        if not isinstance(records, list) or len(records) > 256:
            raise ValueError("Invalid participant list")
        members = {}
        for record in records:
            if not isinstance(record, dict) or not identifier(record.get("peerId")):
                raise ValueError("Invalid participant identity")
            if record["peerId"] in members:
                raise ValueError("Duplicate participant identity")
            for key in ("ready", "loaded", "ignored", "participating"):
                if not isinstance(record.get(key), bool):
                    raise ValueError("Invalid participant state")
            if type(record.get("sequence", -1)) is not int or record.get("sequence", -1) < -1:
                raise ValueError("Invalid participant sequence")
            if record.get("instance", "") and not identifier(record["instance"]):
                raise ValueError("Invalid participant instance")
            members[record["peerId"]] = Member(record["peerId"], display_name(record.get("displayName")),
                instance=record.get("instance", ""), ready=record["ready"], loaded=record["loaded"],
                ignored=record["ignored"], participating=record["participating"],
                sequence=record.get("sequence", -1))
        self.members = members