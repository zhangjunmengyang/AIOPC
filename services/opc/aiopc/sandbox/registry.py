"""Which environment a project runs in, and remembering that choice.

AIOPC ships with the local sandbox so everything works without an account
anywhere. A person who already pays for a cloud browser points AIOPC at it
instead: the key goes in the keychain, the project's environment moves there,
and nothing else in AIOPC changes.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from aiopc import credentials

from .environment import Environment, ProjectKey, Provider, SandboxError
from .leases import LeaseManager
from .local import LocalDockerProvider
from .pool import EnvironmentPool
from .pool_store import PoolStore
from .remote import REMOTE_CATALOG, ManualProvider, RemoteProvider

SERVICE = "sandbox"
DEFAULT = "local"


def secret_key(provider_id: str) -> str:
    return f"{SERVICE}:{provider_id}"


class Sandboxes(EnvironmentPool):
    """Every project's environment, and the provider behind each one."""

    def __init__(self, home: Path):
        self.home = Path(home)
        self._store = PoolStore(self.home)
        self.leases = LeaseManager(self.home, binding_resolver=self.get)
        self.file = self.home / "sandbox.json"
        self._lock = asyncio.Lock()
        self._providers: dict[str, Provider] = {DEFAULT: LocalDockerProvider(self.home), "manual": ManualProvider()}
        for spec in REMOTE_CATALOG:
            self._providers[spec.info.id] = RemoteProvider(spec)

    # ── what AIOPC remembers ────────────────────────────────────────────
    def _read(self) -> dict[str, Any]:
        return self._store.read()

    def record(self, project: str) -> dict[str, Any]:
        try:
            record = self.resolve(project)
            return {"provider": record["provider"], "state": record["state"]}
        except SandboxError:
            if any(item.get("boundProject") == str(Path(project).resolve())
                   for item in self._store.read()["environments"].values()):
                raise
            return {"provider": self.default_provider(), "state": {}}

    def default_provider(self) -> str:
        return str(self._read().get("provider") or DEFAULT)

    def set_default_provider(self, provider_id: str) -> None:
        self.provider(provider_id)
        self._store.update(lambda data: data.update(provider=provider_id))

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

    async def stop(self, project: str, environment: str = "") -> dict[str, Any]:
        record = self.resolve(project, environment)
        async with self._mutation(record["id"]):
            record = self.get(record["id"])
            self._secrets(record)
            await self.provider(record["provider"]).stop(self._resource_key(record), record["state"])
            self._save_record(record)
        return {"stopped": True}

    async def destroy(self, project: str, environment: str = "") -> dict[str, Any]:
        record = self.resolve(project, environment)
        async with self._mutation(record["id"]):
            record = self.get(record["id"])
            self._secrets(record)
            await self.provider(record["provider"]).destroy(self._resource_key(record), record["state"])
            record["state"] = {}
            self._save_record(record)
        return {"destroyed": True}

    async def move(self, project: str, provider_id: str) -> Environment:
        """Compatibility for the former provider chooser: keep old resources in the pool."""
        self.provider(provider_id)
        if provider_id != DEFAULT and not self.configured(provider_id):
            raise SandboxError("这个提供方还没有填密钥")
        try:
            current = self.resolve(project)
        except SandboxError:
            current = None
        if current and current["provider"] == provider_id:
            return await self.status(project)
        if current:
            await self.unbind(current["id"])
        import uuid
        env_id = "env_" + uuid.uuid4().hex[:24]
        canonical = str(Path(project).resolve())
        from aiopc.company import Company
        record = {"id": env_id, "name": Path(project).name or "环境", "company": str(Company.from_directory(Path(project)).root),
                  "provider": provider_id, "boundProject": canonical, "lastProject": canonical, "bindingRevision": 1,
                  "resourceKey": env_id, "state": {}}
        self._store.save(record)
        self._store.sync_bindings(canonical)
        if provider_id == "manual":
            credentials.save("environment", env_id, credentials.load(SERVICE, provider_id) or {})
        return await self.status(project)

    def can_run_environment(self, project: str = "") -> bool:
        """Whether an environment could start here at all: a container engine, or a cloud key."""
        provider_id = self.record(project)["provider"] if project else self.default_provider()
        if provider_id == DEFAULT:
            from .local import find_docker

            return find_docker() is not None
        return self.configured(provider_id)

