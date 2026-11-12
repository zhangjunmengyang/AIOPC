"""Account registry: the social accounts AIOPC knows, shared by every workspace.

A login lives in the environment of the project it was made in, so an account
belongs to that project. Only public identities are kept here;
nothing secret is stored.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from filelock import FileLock

from aiopc.platforms import ALIASES, PLATFORMS

ACCOUNT_ID = re.compile(r"acc_[0-9a-f]{12}\Z")


class AccountError(ValueError):
    pass


def normalize_platform(value: str) -> str:
    key = ALIASES.get(str(value or "").strip().casefold())
    if key is None:
        raise AccountError(f"不认识的平台：{value}。可用：{'、'.join(PLATFORMS.values())}")
    return key


class AccountStore:
    def __init__(self, home: Path):
        self.path = Path(home) / "accounts.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = FileLock(str(self.path.with_suffix(".lock")), timeout=5)

    def _read(self) -> list[dict[str, Any]]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8")) if self.path.is_file() else []
        except (OSError, ValueError):
            raise AccountError(f"账号文件损坏，请检查 {self.path}") from None
        return data if isinstance(data, list) else []

    def _write(self, accounts: list[dict[str, Any]]) -> None:
        fd, temporary = tempfile.mkstemp(prefix=".accounts-", dir=self.path.parent)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(accounts, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, self.path)

    def list(self) -> list[dict[str, Any]]:
        return self._read()

    def get(self, account_id: str) -> dict[str, Any]:
        if not isinstance(account_id, str) or not ACCOUNT_ID.fullmatch(account_id):
            raise AccountError("账号 ID 无效")
        account = next((item for item in self._read() if item["id"] == account_id), None)
        if account is None:
            raise AccountError("账号不存在")
        return account

    def upsert(self, platform: str, identity: dict[str, Any], *, alias: str = "", route: str = "browser",
               project: str | None = None, environment: str | None = None) -> dict[str, Any]:
        """Save the account found logged in; the same platform identity updates in place."""
        platform = normalize_platform(platform)
        with self._lock:
            accounts = self._read()
            existing = next((item for item in accounts if item["platform"] == platform
                             and item.get("identity", {}).get("id") == identity["id"]
                             and (item.get("project") or None) == (project or None)
                             and (item.get("environment") or None) == (environment or None)), None)
            if existing is None and environment:
                existing = next((item for item in accounts if item["platform"] == platform
                                 and item.get("identity", {}).get("id") == identity["id"]
                                 and item.get("project") == project and not item.get("environment")
                                 and item.get("logged_in") is False), None)
            now = time.time()
            if existing is None:
                existing = {"id": "acc_" + uuid.uuid4().hex[:12], "platform": platform, "route": route,
                            "alias": alias.strip()[:80], "created_at": now}
                accounts.append(existing)
            elif alias:
                existing["alias"] = alias.strip()[:80]
            if environment and route == "browser":
                # One browser profile has one active identity per platform.
                # Retain the previous account's history and API credentials,
                # but stop advertising its browser login immediately.
                for account in accounts:
                    if (account["platform"] == platform and account.get("environment") == environment
                            and str(account.get("identity", {}).get("id") or "") != str(identity["id"])):
                        account.update(logged_in=False, checked_at=now, updated_at=now)
            existing.update(identity={key: str(identity.get(key) or "")[:500] for key in ("id", "name", "handle", "url")},
                            verified_at=now, updated_at=now, logged_in=True, checked_at=now)
            if project is not None:
                # The login lives in this project's environment, and belongs to that project alone.
                existing["project"] = str(project)
            if environment:
                existing["environment"] = environment
            self._write(accounts)
            return dict(existing)

    def assign_legacy_environment(self, project: str, environment: str) -> None:
        with self._lock:
            accounts = self._read()
            changed = False
            for account in accounts:
                if account.get("project") == project and not account.get("environment"):
                    account["environment"] = environment
                    changed = True
            if changed:
                self._write(accounts)

    def detach_environment(self, environment: str) -> None:
        """Keep identities/history with their project after a browser profile reset."""
        with self._lock:
            accounts = self._read()
            for account in accounts:
                if account.get("environment") == environment:
                    account.pop("environment", None)
                    account.update(logged_in=False, checked_at=time.time(), updated_at=time.time())
            self._write(accounts)

    def mark_checked(self, account_id: str, logged_in: bool) -> None:
        """Record whether the login was still there when AIOPC last looked."""
        with self._lock:
            accounts = self._read()
            account = next((item for item in accounts if item["id"] == account_id), None)
            if account is None:
                return
            account["logged_in"] = bool(logged_in)
            account["checked_at"] = time.time()
            self._write(accounts)

    def update(self, account_id: str, *, alias: str | None = None) -> dict[str, Any]:
        with self._lock:
            accounts = self._read()
            account = next((item for item in accounts if item["id"] == account_id), None)
            if account is None:
                raise AccountError("账号不存在")
            if alias is not None:
                account["alias"] = str(alias).strip()[:80]
            account["updated_at"] = time.time()
            self._write(accounts)
            return dict(account)

    def set_route(self, account_id: str, route_id: str, public: dict[str, Any] | None) -> dict[str, Any]:
        """Attach (public details only; secrets stay in the Keychain) or detach an official route."""
        with self._lock:
            accounts = self._read()
            account = next((item for item in accounts if item["id"] == account_id), None)
            if account is None:
                raise AccountError("账号不存在")
            routes = dict(account.get("routes") or {})
            if public is None:
                routes.pop(route_id, None)
            else:
                routes[route_id] = {key: str(value)[:200] for key, value in public.items()} | {"added_at": time.time()}
            account["routes"] = routes
            account["updated_at"] = time.time()
            self._write(accounts)
            return dict(account)

    def delete(self, account_id: str) -> None:
        with self._lock:
            accounts = self._read()
            remaining = [item for item in accounts if item["id"] != account_id]
            if len(remaining) == len(accounts):
                raise AccountError("账号不存在")
            self._write(remaining)
