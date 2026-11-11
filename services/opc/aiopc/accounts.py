"""Account registry: which social accounts the lab and each project may use.

Accounts are public identities only (platform, who, owner, sharing). Logins live
in AIOPC's built-in browser; nothing secret is stored here.
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

from aiopc.projects import LAB_ID, ProjectError, ProjectService

PLATFORMS: dict[str, str] = {
    "xhs": "小红书", "x": "X", "zhihu": "知乎", "jike": "即刻", "weibo": "微博", "douyin": "抖音",
    "bilibili": "B站", "kuaishou": "快手", "wechat": "公众号", "channels": "视频号", "linkedin": "LinkedIn",
    "threads": "Threads", "bluesky": "Bluesky", "juejin": "掘金", "toutiao": "头条号", "youtube": "YouTube",
    "tiktok": "TikTok",
}
ALIASES = {"小红书": "xhs", "xiaohongshu": "xhs", "rednote": "xhs", "twitter": "x", "知乎": "zhihu", "即刻": "jike",
           "微博": "weibo", "抖音": "douyin", "b站": "bilibili", "哔哩哔哩": "bilibili", "快手": "kuaishou",
           "公众号": "wechat", "微信公众号": "wechat", "视频号": "channels", "掘金": "juejin", "头条": "toutiao", "头条号": "toutiao"}
ACCOUNT_ID = re.compile(r"acc_[0-9a-f]{12}\Z")


class AccountError(ValueError):
    pass


def normalize_platform(value: str) -> str:
    key = str(value or "").strip()
    key = ALIASES.get(key.casefold(), ALIASES.get(key, key.casefold()))
    if key not in PLATFORMS:
        raise AccountError(f"不支持的平台：{value}。可用：{'、'.join(PLATFORMS.values())}")
    return key


def usable_by(account: dict[str, Any], project_id: str | None) -> bool:
    shared = account.get("shared_with") or []
    target = project_id or LAB_ID
    return (account.get("project_id") or None) == (project_id or None) or "*" in shared or target in shared


class AccountStore:
    def __init__(self, workspace: Path):
        self.workspace = Path(workspace)
        self.projects = ProjectService(self.workspace)
        self.path = self.workspace / ".aiopc" / "accounts.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = FileLock(str(self.path.with_suffix(".lock")), timeout=5)

    def _read(self) -> list[dict[str, Any]]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8")) if self.path.is_file() else []
        except (OSError, ValueError):
            raise AccountError("账号文件损坏，请检查 .aiopc/accounts.json") from None
        return data if isinstance(data, list) else []

    def _write(self, accounts: list[dict[str, Any]]) -> None:
        fd, temporary = tempfile.mkstemp(prefix=".accounts-", dir=self.path.parent)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(accounts, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, self.path)

    def _project(self, project_id: Any) -> str | None:
        try:
            return self.projects.require(project_id)
        except ProjectError as exc:
            raise AccountError(exc.message) from None

    def list(self, project_id: Any = None, *, all_scopes: bool = False) -> list[dict[str, Any]]:
        accounts = self._read()
        if all_scopes:
            return accounts
        project = self._project(project_id)
        return [account for account in accounts if usable_by(account, project)]

    def get(self, account_id: str) -> dict[str, Any]:
        if not isinstance(account_id, str) or not ACCOUNT_ID.fullmatch(account_id):
            raise AccountError("账号 ID 无效")
        account = next((item for item in self._read() if item["id"] == account_id), None)
        if account is None:
            raise AccountError("账号不存在")
        return account

    def upsert(self, platform: str, identity: dict[str, Any], *, project_id: Any = None, alias: str = "",
               route: str = "browser") -> dict[str, Any]:
        """Save the account found logged in; the same platform identity updates in place."""
        platform = normalize_platform(platform)
        project = self._project(project_id)
        with self._lock:
            accounts = self._read()
            existing = next((item for item in accounts if item["platform"] == platform
                             and item.get("identity", {}).get("id") == identity["id"]), None)
            now = time.time()
            if existing is None:
                existing = {"id": "acc_" + uuid.uuid4().hex[:12], "platform": platform, "route": route,
                            "project_id": project, "shared_with": [], "alias": alias.strip()[:80], "created_at": now}
                accounts.append(existing)
            elif alias:
                existing["alias"] = alias.strip()[:80]
            existing.update(identity={key: str(identity.get(key) or "")[:500] for key in ("id", "name", "handle", "url")},
                            verified_at=now, updated_at=now)
            self._write(accounts)
            return dict(existing)

    def update(self, account_id: str, *, alias: str | None = None, project_id: Any = ..., shared_with: list[str] | None = None) -> dict[str, Any]:
        with self._lock:
            accounts = self._read()
            account = next((item for item in accounts if item["id"] == account_id), None)
            if account is None:
                raise AccountError("账号不存在")
            if alias is not None:
                account["alias"] = str(alias).strip()[:80]
            if project_id is not ...:
                account["project_id"] = self._project(project_id)
            if shared_with is not None:
                if not isinstance(shared_with, list) or not all(isinstance(item, str) for item in shared_with):
                    raise AccountError("共享范围无效")
                clean = ["*"] if "*" in shared_with else [item for item in dict.fromkeys(shared_with)
                                                          if item == LAB_ID or self.projects.exists(item)]
                account["shared_with"] = [item for item in clean if item != (account.get("project_id") or LAB_ID)]
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
