"""Serverless control channel over a public MQTT broker.

Messages are AES-GCM encrypted (see :mod:`.crypto`) so the broker only relays
opaque ciphertext. The room topic is a SHA-256 hash of the room code, so the
plaintext code never appears on the wire either.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any

import paho.mqtt.client as mqtt
from PySide6.QtCore import QObject, Signal

from .. import config
from . import crypto

log = logging.getLogger(__name__)


class RoomChannel(QObject):
    """Publishes/subscribes encrypted JSON control messages for one room."""

    message_received = Signal(dict)
    connected = Signal()
    disconnected = Signal()

    def __init__(self, room_code: str, password: str, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._room_code = room_code
        self._key = crypto.derive_key(room_code, password)
        self._topic = self._make_topic(room_code)
        self._broker = config.DEFAULT_MQTT_BROKERS[0]

        client_id = f"{config.APP_ID}-{os.urandom(4).hex()}"
        self._client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=client_id,
            protocol=mqtt.MQTTv311,
        )
        self._client.on_connect = self._on_connect
        self._client.on_message = self._on_message
        self._client.on_disconnect = self._on_disconnect

    @staticmethod
    def _make_topic(room_code: str) -> str:
        digest = hashlib.sha256(f"{config.APP_ID}:{room_code}".encode("utf-8")).hexdigest()
        return f"{config.MQTT_TOPIC_PREFIX}/{digest}"

    @property
    def topic(self) -> str:
        return self._topic

    def start(self) -> None:
        host, port = self._broker
        log.info("Connecting to MQTT broker %s:%s", host, port)
        self._client.connect_async(host, port, keepalive=30)
        self._client.loop_start()

    def stop(self) -> None:
        try:
            self._client.loop_stop()
            self._client.disconnect()
        except Exception:  # pragma: no cover - best effort cleanup
            log.debug("Error stopping MQTT client", exc_info=True)

    def publish(self, message: dict[str, Any]) -> None:
        try:
            payload = crypto.encrypt(self._key, json.dumps(message).encode("utf-8"))
            self._client.publish(self._topic, payload, qos=0)
        except Exception:  # pragma: no cover
            log.exception("Failed to publish message")

    # --- paho callbacks (run on the MQTT network thread) ---------------------

    def _on_connect(self, client, userdata, flags, reason_code, properties=None) -> None:
        client.subscribe(self._topic, qos=0)
        log.info("MQTT connected (rc=%s), subscribed to %s", reason_code, self._topic)
        self.connected.emit()

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None) -> None:
        log.info("MQTT disconnected (rc=%s)", reason_code)
        self.disconnected.emit()

    def _on_message(self, client, userdata, msg) -> None:
        try:
            plaintext = crypto.decrypt(self._key, msg.payload)
            message = json.loads(plaintext.decode("utf-8"))
        except Exception:
            # Wrong key, tampered, or foreign message: ignore silently.
            return
        if isinstance(message, dict):
            self.message_received.emit(message)
