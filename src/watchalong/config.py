"""Application-wide configuration and constants."""

from __future__ import annotations

import os

APP_ID = "koodaamo-watchalong"
APP_VERSION = "0.3.2"

# Build variant: "portable" (default) or "installer" (auto-updating). Installer
# builds bundle a generated ``_build_variant`` module that overrides this.
APP_VARIANT = "portable"
try:  # pragma: no cover - _build_variant exists only in installer builds
    from ._build_variant import APP_VARIANT as _VARIANT  # type: ignore

    APP_VARIANT = _VARIANT
except Exception:
    pass

# GitHub repository queried for forced auto-updates (installer builds only).
GITHUB_OWNER = "Salabombou"
GITHUB_REPO = "koodaamo-watchalong"

# Public BitTorrent trackers (no auth). Added to every magnet for reliable peer
# discovery in addition to the DHT.
DEFAULT_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://open.stealth.si:80/announce",
]

# DHT bootstrap nodes for trackerless peer discovery.
DHT_BOOTSTRAP_NODES = [
    ("router.bittorrent.com", 6881),
    ("dht.transmissionbt.com", 6881),
    ("router.utorrent.com", 6881),
]

# Public MQTT brokers used for the (end-to-end encrypted) control channel.
# Only tiny control messages travel here; bulk video is always peer-to-peer.
DEFAULT_MQTT_BROKERS = [
    ("broker.hivemq.com", 1883),
    ("test.mosquitto.org", 1883),
    ("broker.emqx.io", 1883),
]

MQTT_TOPIC_PREFIX = "koodaamo-watchalong"

# Local HTTP streaming server that bridges libtorrent -> media players.
STREAM_HOST = "127.0.0.1"
STREAM_PORT = 0  # 0 = pick a free port automatically

# BitTorrent listen port range start.
TORRENT_LISTEN_PORT = 6881

VIDEO_EXTENSIONS = {
    ".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v",
    ".ts", ".flv", ".wmv", ".mpg", ".mpeg", ".ogv",
}


def default_download_dir() -> str:
    base = os.path.join(os.path.expanduser("~"), "Downloads", "koodaamo-watchalong")
    os.makedirs(base, exist_ok=True)
    return base
