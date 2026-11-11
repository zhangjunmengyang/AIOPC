"""Secrets for official routes (API keys, app passwords), kept in the macOS Keychain.

Nothing secret is written into AIOPC's files or shown to the AI: account records
only say which routes exist, and the route asks this store for its secret when it
runs.
"""

from __future__ import annotations

import json
from typing import Any

import keyring
from keyring.errors import KeyringError

SERVICE = "AIOPC"


class CredentialError(ValueError):
    pass


def _key(account_id: str, route: str) -> str:
    return f"{account_id}:{route}"


def save(account_id: str, route: str, secret: dict[str, Any]) -> None:
    try:
        keyring.set_password(SERVICE, _key(account_id, route), json.dumps(secret))
    except KeyringError as exc:
        raise CredentialError(f"无法写入系统钥匙串：{exc}") from None


def load(account_id: str, route: str) -> dict[str, Any] | None:
    try:
        raw = keyring.get_password(SERVICE, _key(account_id, route))
    except KeyringError:
        return None
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def delete(account_id: str, route: str) -> None:
    try:
        keyring.delete_password(SERVICE, _key(account_id, route))
    except KeyringError:
        pass
