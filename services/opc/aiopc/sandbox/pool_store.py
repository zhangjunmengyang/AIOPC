"""Versioned environment resources. Provider I/O never runs under this short lock."""

from __future__ import annotations

import copy
import json
import os
import tempfile
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from filelock import FileLock

from aiopc import credentials
from aiopc.accounts import AccountStore
from aiopc.authorized_workspaces import AuthorizedWorkspaces, WorkspaceForbidden
from aiopc.company import Company

from .environment import ProjectKey, SandboxError


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise SandboxError("环境记录不能写入符号链接")
    fd, temporary = tempfile.mkstemp(prefix=".aiopc-environments-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class PoolStore:
    def __init__(self, home: Path):
        self.home = Path(home)
        self.home.mkdir(parents=True, exist_ok=True)
        self.path = self.home / "sandbox.json"
        self.lock = FileLock(str(self.home / "sandbox.lock"), timeout=10)

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"schemaVersion": 2, "provider": "local", "environments": {}}
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            raise SandboxError("环境记录无法读取，请检查 sandbox.json；原文件未被覆盖") from None
        if not isinstance(data, dict):
            raise SandboxError("环境记录格式无效")
        if data.get("schemaVersion") == 2:
            return data
        backup = self.home / "sandbox.v1.backup.json"
        if not backup.exists():
            atomic_json(backup, data)
        migrated = {"schemaVersion": 2, "provider": data.get("provider") or "local", "environments": {}}
        for project, old in (data.get("projects") or {}).items():
            canonical = str(Path(project).expanduser().resolve())
            # Preserve the original provider naming input, not a newly generated env ID.
            env_id = "env_" + uuid.uuid5(uuid.NAMESPACE_URL, "aiopc:legacy:" + project).hex[:24]
            state = dict(old.get("state") or {})
            state.pop("_secret", None)
            provider = old.get("provider") or migrated["provider"]
            if provider == "manual":
                credentials.save("environment", env_id, credentials.load("sandbox", provider) or {})
            if provider == "browseruse" and not state.get("profile"):
                profile = (credentials.load("sandbox", provider) or {}).get("profile_id")
                if profile:
                    state["profile"] = profile
            if provider == "local":
                state.setdefault("container", "aiopc-" + ProjectKey(project).slug)
                state.setdefault("volume", "aiopc-" + ProjectKey(project).slug + "-profile")
            try:
                _, company = AuthorizedWorkspaces().resolve_context(canonical)
            except WorkspaceForbidden:
                # Keep unopened legacy resources; authorization is still checked
                # separately before HTTP exposes any company's pool.
                company = Company.from_directory(Path(project))
            record = {"id": env_id, "name": Path(project).name or "原有环境",
                      "company": str(company.root), "provider": provider,
                      "boundProject": canonical, "lastProject": canonical, "bindingRevision": 1,
                      "resourceKey": project, "state": state, "createdAt": time.time()}
            migrated["environments"][env_id] = record
            AccountStore(self.home).assign_legacy_environment(project, env_id)
        atomic_json(self.path, migrated)
        for record in migrated["environments"].values():
            root = Path(record["boundProject"])
            if root.is_dir() and not root.is_symlink():
                atomic_json(root / "environments.json", {"schemaVersion": 1, "environments": [record["id"]]})
        return migrated

    def read(self) -> dict[str, Any]:
        with self.lock:
            return copy.deepcopy(self._read())

    def update(self, operation: Callable[[dict[str, Any]], Any]) -> Any:
        with self.lock:
            data = self._read()
            result = operation(data)
            atomic_json(self.path, data)
            return copy.deepcopy(result)

    def get(self, env_id: str) -> dict[str, Any]:
        record = self.read().get("environments", {}).get(env_id)
        if not record:
            raise SandboxError("环境不存在")
        return record

    def save(self, record: dict[str, Any]) -> dict[str, Any]:
        def change(data):
            existing = data["environments"].get(record["id"])
            if existing and existing["bindingRevision"] != record["bindingRevision"]:
                raise SandboxError("环境绑定已改变，请重新选择环境")
            data["environments"][record["id"]] = record
            return record
        return self.update(change)

    def create(self, company: str, name: str, provider: str, *,
               prepare: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
        root = Path(company).expanduser().resolve()
        if not root.is_dir():
            raise SandboxError("公司目录不存在")
        if not name.strip() or len(name.strip()) > 120:
            raise SandboxError("环境名称需为 1–120 字")
        env_id = "env_" + uuid.uuid4().hex[:24]
        record = {"id": env_id, "name": name.strip(), "company": str(root), "provider": provider,
                  "boundProject": None, "lastProject": None, "bindingRevision": 0,
                  "resourceKey": env_id, "state": {}, "createdAt": time.time()}
        if prepare:
            prepare(record)
        return self.save(record)

    def list(self, company: str) -> list[dict[str, Any]]:
        root = str(Path(company).expanduser().resolve())
        return [record for record in self.read()["environments"].values() if record["company"] == root]

    @staticmethod
    def validate_binding(project: str, company: str) -> Path | None:
        root, boundary = Path(project), Path(company)
        if (not boundary.is_absolute() or boundary.is_symlink() or boundary.resolve() != boundary
                or not root.is_absolute() or root.is_symlink() or root.resolve() != root):
            raise SandboxError("环境绑定目录不能是符号链接或位于公司之外")
        if root != boundary:
            base = boundary / "projects"
            if base.is_symlink() or base.resolve() != base or root.parent != base:
                raise SandboxError("环境绑定目录必须位于当前公司的 projects 下")
            Company.project_name(root.name)
        # Removed projects have no projection left to update. A symlink, even
        # a broken one, was rejected above before any registry mutation.
        if not root.exists():
            return None
        if not root.is_dir() or (root / "environments.json").is_symlink():
            raise SandboxError("环境绑定文件不能写入符号链接")
        return root

    def sync_bindings(self, project: str, company: str | None = None) -> None:
        # Keep the snapshot and its projection in the same short lock. Two
        # independent environment binds must not publish an older project file.
        with self.lock:
            records = self._read()["environments"].values()
            if company is None:
                matches = {item["company"] for item in records
                           if project in (item.get("boundProject"), item.get("lastProject"))}
                if len(matches) != 1:
                    raise SandboxError("无法确认环境绑定所属公司")
                company = matches.pop()
            root = self.validate_binding(project, company)
            if root is None:
                return
            atomic_json(root / "environments.json", {"schemaVersion": 1,
                        "environments": sorted(item["id"] for item in records if item.get("boundProject") == str(root))})
