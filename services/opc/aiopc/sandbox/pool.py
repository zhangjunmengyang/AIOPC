"""Company resource pool operations; browser leases are layered at the call boundary."""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from filelock import FileLock

from aiopc import credentials
from aiopc.accounts import PLATFORMS, AccountStore
from aiopc.company import Company

from .environment import Environment, ProjectKey, SandboxError


class EnvironmentPool:
    def get(self, environment: str) -> dict[str, Any]:
        return self._store.get(environment)

    def list_environments(self, company: str) -> list[dict[str, Any]]:
        return self._store.list(company)

    def create_environment(self, company: str, name: str, provider_id: str = "local",
                           fields: dict[str, Any] | None = None) -> dict[str, Any]:
        provider = self.provider(provider_id)
        if provider.info.kind != "local" and not self.configured(provider_id) and not fields:
            raise SandboxError("这个提供方还没有填写连接信息")
        values = {key: str(value).strip() for key, value in (fields or {}).items() if str(value).strip()}
        if provider_id == "manual" and not values.get("cdp_url"):
            raise SandboxError("请为这个环境单独填写 DevTools 地址")
        def normalize_endpoint(value: str) -> str:
            endpoint = urlsplit(value.strip())
            host = endpoint.hostname
            if not host:
                raise SandboxError("DevTools 地址缺少主机名")
            host = f"[{host.lower()}]" if ":" in host else host.lower()
            userinfo = endpoint.netloc.rsplit("@", 1)[0] + "@" if "@" in endpoint.netloc else ""
            port = f":{endpoint.port}" if endpoint.port is not None else ""
            return urlunsplit((endpoint.scheme.lower(), userinfo + host + port,
                               endpoint.path.rstrip("/"), endpoint.query, endpoint.fragment))

        def register():
            if provider_id == "manual":
                endpoint = normalize_endpoint(values["cdp_url"])
                for existing in self._store.read()["environments"].values():
                    old = credentials.load("environment", existing["id"]) or {}
                    if (existing["provider"] == "manual" and old.get("cdp_url")
                            and normalize_endpoint(old["cdp_url"]) == endpoint):
                        raise SandboxError("这个 DevTools 地址已被另一个环境使用，请提供独立浏览器地址")
            prepared = None

            def prepare(record):
                nonlocal prepared
                if values:
                    prepared = record["id"]
                    credentials.save("environment", prepared, values)

            try:
                # Save credentials before publishing the record. A keychain
                # failure cannot leave a visible, half-configured resource.
                return self._store.create(str(Path(company).expanduser().resolve()), name, provider_id, prepare=prepare)
            except Exception:  # Roll back the secret, then preserve the original failure.
                if prepared:
                    credentials.delete("environment", prepared)
                raise

        if provider_id == "manual":
            # This lock spans duplicate checking and both stores, across HTTP
            # and MCP processes. Provider/network I/O never runs in this lock.
            with FileLock(str(self.home / "manual-endpoints.lock"), timeout=10):
                return register()
        return register()

    def resolve(self, project: str, environment: str = "") -> dict[str, Any]:
        path = str(Path(project).expanduser().resolve())
        if environment:
            record = self.get(environment)
            if record.get("boundProject") != path:
                raise SandboxError("这个环境没有绑定到当前项目")
            return record
        matches = [item for item in self._store.read()["environments"].values() if item.get("boundProject") == path]
        if not matches:
            raise SandboxError("当前项目还没有绑定环境，请从资源池添加环境")
        if len(matches) != 1:
            raise SandboxError("当前项目绑定了多个环境，请明确指定 environment：" +
                               "、".join(f"{item['name']} ({item['id']})" for item in matches))
        return matches[0]

    @asynccontextmanager
    async def _resource_lock(self, environment: str):
        # Provider state is read only after acquiring this lock; no global lock
        # is held while a provider performs network/container I/O.
        directory = self.home / "sandbox-locks"
        directory.mkdir(exist_ok=True)
        lock = FileLock(str(directory / (environment + ".lock")), timeout=180, thread_local=False)
        await asyncio.to_thread(lock.acquire)
        try:
            yield
        finally:
            lock.release()

    @asynccontextmanager
    async def _mutation(self, environment: str):
        async with self._resource_lock(environment):
            record = self.get(environment)
            async with self.leases.maintenance(environment, record["bindingRevision"]):
                yield record

    async def stop_resource(self, environment: str) -> dict[str, Any]:
        async with self._mutation(environment) as record:
            self._secrets(record)
            await self.provider(record["provider"]).stop(self._resource_key(record), record["state"])
            self._save_record(record)
        return {"stopped": True, "id": environment}

    async def destroy_resource(self, environment: str) -> dict[str, Any]:
        async with self._mutation(environment) as record:
            if record.get("boundProject"):
                self._store.validate_binding(record["boundProject"], record["company"])
            self._secrets(record)
            await self.provider(record["provider"]).reset(self._resource_key(record), record["state"])
            AccountStore(self.home).detach_environment(environment)
            self._store.update(lambda data: data["environments"].pop(environment))
            credentials.delete("environment", environment)
            if record.get("boundProject"):
                self._store.sync_bindings(record["boundProject"], record["company"])
        return {"destroyed": True, "id": environment}

    @staticmethod
    def _resource_key(record: dict[str, Any]) -> ProjectKey:
        return ProjectKey(str(record["resourceKey"]))

    def _secrets(self, record: dict[str, Any]) -> None:
        if record["provider"] != "local":
            record["state"]["_secret"] = {**(credentials.load("sandbox", record["provider"]) or {}),
                                           **(credentials.load("environment", record["id"]) or {})}

    def _save_record(self, record: dict[str, Any]) -> dict[str, Any]:
        record["state"].pop("_secret", None)
        return self._store.save(record)

    def _affected_accounts(self, environment: str) -> list[dict[str, Any]]:
        return [{"account_id": item["id"], "platform": item["platform"],
                 "platform_name": PLATFORMS.get(item["platform"], item["platform"]),
                 "name": item.get("alias") or item.get("identity", {}).get("name") or item["platform"],
                 "environment": environment, "status": "ready" if item.get("logged_in") else "needs_login",
                 "project": item.get("project"), "identity": item.get("identity"), "updated_at": item.get("updated_at")}
                for item in AccountStore(self.home).list() if item.get("environment") == environment]

    async def bind(self, environment: str, project: str, *, confirmation: str = "") -> dict[str, Any]:
        async with self._mutation(environment) as record:
            target = str(Company(Path(record["company"])).resolve_project(project))
            old = record.get("boundProject")
            self._store.validate_binding(target, record["company"])
            if old:
                self._store.validate_binding(old, record["company"])
            if old == target:
                return record
            if record.get("lastProject") and record["lastProject"] != target:
                accounts = self._affected_accounts(environment)
                digest = hashlib.sha256(json.dumps([record["bindingRevision"], record["lastProject"], target, accounts],
                                                    sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                review = record.get("rebindReview") or {}
                if (not confirmation or not secrets.compare_digest(confirmation, str(review.get("token", "")))
                        or review.get("digest") != digest or review.get("expiresAt", 0) < time.time()):
                    token = secrets.token_urlsafe(24)
                    record["rebindReview"] = {"token": token, "digest": digest, "expiresAt": time.time() + 300}
                    self._save_record(record)
                    return {"requires_confirmation": True, "confirmation": token, "affectedAccounts": accounts,
                            "id": environment, "project": target}
                self._secrets(record)
                await self.provider(record["provider"]).reset(self._resource_key(record), record["state"])
                record["state"].pop("_secret", None)
                AccountStore(self.home).detach_environment(environment)
                # Services which name their profiles from the resource key must
                # never reopen a prior project's profile after the reset.
                record["resourceKey"] = environment + "-" + secrets.token_hex(6)
                record["state"] = {}
            record.pop("rebindReview", None)
            record["boundProject"] = target
            record["lastProject"] = target
            previous_revision = record["bindingRevision"]
            def update(data):
                if data["environments"][environment]["bindingRevision"] != previous_revision:
                    raise SandboxError("环境绑定已改变，请重新确认")
                record["bindingRevision"] += 1
                data["environments"][environment] = record
                return record
            result = self._store.update(update)
            if old:
                self._store.sync_bindings(old, record["company"])
            self._store.sync_bindings(target, record["company"])
            return result

    async def unbind(self, environment: str) -> dict[str, Any]:
        async with self._mutation(environment) as record:
            old = record.get("boundProject")
            if old:
                self._store.validate_binding(old, record["company"])
            def update(data):
                item = data["environments"][environment]
                if item.get("boundProject"):
                    item["lastProject"] = item["boundProject"]
                    item["boundProject"] = None
                    item["bindingRevision"] += 1
                    item.pop("rebindReview", None)
                return item
            result = self._store.update(update)
            if old:
                self._store.sync_bindings(old, record["company"])
            return result

    async def describe_environment(self, environment: str) -> dict[str, Any]:
        record = self.get(environment)
        self._secrets(record)
        try:
            status = await self.provider(record["provider"]).status(self._resource_key(record), record["state"])
        except SandboxError as exc:
            status = Environment(provider=record["provider"], detail=str(exc))
        return {**status.describe(), **{key: record.get(key) for key in
                ("id", "name", "company", "provider", "boundProject", "lastProject", "bindingRevision")},
                "provider_id": record["provider"]}

    async def start_resource(self, environment: str) -> Environment:
        async with self._resource_lock(environment):
            record = self.get(environment)
            self._secrets(record)
            status = await self.provider(record["provider"]).ensure(self._resource_key(record), record["state"])
            self._save_record(record)
            status.id = environment
            return status

    async def status(self, project: str, environment: str = "") -> Environment:
        try:
            record = self.resolve(project, environment)
        except SandboxError:
            if environment or any(item.get("boundProject") == str(Path(project).resolve())
                                  for item in self._store.read()["environments"].values()):
                raise
            return Environment(provider=self.default_provider(), detail="尚未绑定环境")
        data = await self.describe_environment(record["id"])
        return Environment(**{key: data[key] for key in Environment.__dataclass_fields__ if key in data})

    async def ensure(self, project: str, environment: str = "") -> Environment:
        return await self.start_resource(self.resolve(project, environment)["id"])
