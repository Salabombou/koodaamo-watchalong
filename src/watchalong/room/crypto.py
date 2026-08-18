"""End-to-end encryption for the control channel.

All control messages are encrypted with AES-256-GCM using a key derived from the
room code and password, so the public MQTT broker only ever sees ciphertext.
"""

from __future__ import annotations

import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

_NONCE_LEN = 12
_KEY_LEN = 32
_ITERATIONS = 200_000


def derive_key(room_code: str, password: str) -> bytes:
    """Derive a shared symmetric key from the room code and password.

    The room code is used as the salt so every peer with the same code and
    password derives the same key without any server exchange.
    """
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=_KEY_LEN,
        salt=room_code.encode("utf-8"),
        iterations=_ITERATIONS,
    )
    return kdf.derive(password.encode("utf-8"))


def encrypt(key: bytes, plaintext: bytes) -> bytes:
    nonce = os.urandom(_NONCE_LEN)
    return nonce + AESGCM(key).encrypt(nonce, plaintext, None)


def decrypt(key: bytes, blob: bytes) -> bytes:
    """Decrypt and authenticate. Raises on tampering or wrong key."""
    if len(blob) <= _NONCE_LEN:
        raise ValueError("ciphertext too short")
    nonce, ciphertext = blob[:_NONCE_LEN], blob[_NONCE_LEN:]
    return AESGCM(key).decrypt(nonce, ciphertext, None)
