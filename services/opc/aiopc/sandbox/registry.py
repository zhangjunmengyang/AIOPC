"""Which environment a project runs in, and remembering that choice.

AIOPC ships with the local sandbox so everything works without an account
anywhere. A person who already pays for a cloud browser points AIOPC at it
instead: the key goes in the keychain, the project's environment moves there,
and nothing else in AIOPC changes.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from aiopc import credentials

from .environment import Environment, ProjectKey, Provider, SandboxError
from .local import LocalDockerProvider
from .remote import REMOTE_CATALOG, ManualProvider, RemoteProvider

SERVICE = "sandbox"
DEFAULT = "local"


def secret_key(provider_id: str) -> str:
    return f"{SERVICE}:{provider_id}"


class Sandboxes:
    """Every project's environment, and the provider behind each one."""

    def __init__(self, home: Path):
        self.home = Path(home)
        self.file = self.home / "sandbox.json"
        self._lock = asyncio.Lock()
        self._providers: dict[str, Provider] = {DEFAULT: LocalDockerProvider(self.home), "manual": ManualProvider()}
        for spec in REMOTE_CATALOG:
            self._providers[spec.info.id] = RemoteProvider(spec)

    # ── what AIOPC remembers ────────────────────────────────────────────
    def _read(self) -> dict[str, Any]:
        try:
            data = json.loads(self.file.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write(self, data: dict[str, Any]) -> None:
        self.home.mkdir(parents=True, exist_ok=True)
        temporary = self.file.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(self.file)

    def record(self, project: str) -> dict[str, Any]:
        data = self._read()
        record = (data.get("projects") or {}).get(str(project)) or {}
        return {"provider": record.get("provider") or data.get("provider") or DEFAULT,
                "state": dict(record.get("state") or {})}

    def save(self, project: str, record: dict[str, Any]) -> None:
        data = self._read()
        projects = dict(data.get("projects") or {})
        projects[str(project)] = record
        data["projects"] = projects
        self._write(data)

    def default_provider(self) -> str:
        return str(self._read().get("provider") or DEFAULT)

    def set_default_provider(self, provider_id: str) -> None:
        self.provider(provider_id)
        data = self._read()
        data["provider"] = provider_id
        self._write(data)

    # ── providers ───────────────────────────────────────────────────────
    def provider(self, provider_id: str) -> Provider:
        provider = self._providers.get(provider_id)
        if provider is None:
            raise SandboxError(f"不认识的环境提供方：{provider_id}")
        return provider

    def configured(self, provider_id: str) -> bool:
        if provider_id == DEFAULT:
            return True
        return credentials.load(SERVICE, provider_id) is not None

    def configure(self, provider_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        """Save a provider's key. Empty fields remove it and fall back to the local sandbox."""
        provider = self.provider(provider_id)
        values = {key: str(value).strip() for key, value in fields.items() if str(value).strip()}
        if not values:
            credentials.delete(SERVICE, provider_id)
            if self.default_provider() == provider_id:
                self.set_default_provider(DEFAULT)
            return {"configured": False, "provider": provider_id}
        missing = [field.label for field in provider.info.fields if not field.optional and not values.get(field.name)]
        if missing:
            raise SandboxError("还缺：" + "、".join(missing))
        credentials.save(SERVICE, provider_id, values)
        return {"configured": True, "provider": provider_id}

    async def describe_providers(self) -> list[dict[str, Any]]:
        described = []
        for provider_id, provider in self._providers.items():
            available, detail = await provider.available()
            described.append(provider.info.describe(configured=self.configured(provider_id), available=available,
                                                    detail=detail))
        order = {DEFAULT: 0, "manual": 9}
        return sorted(described, key=lambda item: (order.get(item["id"], 5), item["name"]))

    # ── a project's environment ─────────────────────────────────────────
    @staticmethod
    def key(project: str) -> ProjectKey:
        return ProjectKey(path=str(project), name=Path(project).name)

    def _bind(self, provider_id: str, state: dict[str, Any]) -> None:
        """Give a cloud provider its key; the local one needs nothing."""
        if provider_id != DEFAULT:
            state["_secret"] = credentials.load(SERVICE, provider_id) or {}

    async def status(self, project: str) -> Environment:
        record = self.record(project)
        provider = self.provider(record["provider"])
        self._bind(record["provider"], record["state"])
        try:
            environment = await provider.status(self.key(project), record["state"])
        except SandboxError as exc:
            return Environment(provider=record["provider"], status="missing", detail=str(exc))
        return environment

    async def ensure(self, project: str) -> Environment:
        async with self._lock:
            record = self.record(project)
            provider = self.provider(record["provider"])
            self._bind(record["provider"], record["state"])
            environment = await provider.ensure(self.key(project), record["state"])
            record["state"].pop("_secret", None)
            self.save(project, record)
            return environment

    async def stop(self, project: str) -> dict[str, Any]:
        record = self.record(project)
        self._bind(record["provider"], record["state"])
        await self.provider(record["provider"]).stop(self.key(project), record["state"])
        record["state"].pop("_secret", None)
        self.save(project, record)
        return {"stopped": True}

    async def destroy(self, project: str) -> dict[str, Any]:
        record = self.record(project)
        self._bind(record["provider"], record["state"])
        await self.provider(record["provider"]).destroy(self.key(project), record["state"])
        self.save(project, {**record, "state": {}})
        return {"destroyed": True}

    async def move(self, project: str, provider_id: str) -> Environment:
        """Point a project at a different provider. The old environment is left alone, not deleted."""
        self.provider(provider_id)
        if provider_id != DEFAULT and not self.configured(provider_id):
            raise SandboxError("这个提供方还没有填密钥")
        record = self.record(project)
        if record["provider"] != provider_id:
            self.save(project, {**record, "provider": provider_id, "state": {}})
        return await self.status(project)

    def can_run_environment(self, project: str = "") -> bool:
        """Whether an environment could start here at all: a container engine, or a cloud key."""
        provider_id = self.record(project)["provider"] if project else self.default_provider()
        if provider_id == DEFAULT:
            from .local import find_docker

            return find_docker() is not None
        return self.configured(provider_id)

