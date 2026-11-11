"""Cloud environments: the browser services a person may already be paying for.

These services all do the same thing in the same shape — ask for a session, get
back a DevTools address and a picture to watch — so AIOPC describes each one as
a short table of requests instead of carrying a vendor library for each. Adding
a service is adding an entry here.

A person who uses something not on this list fills in the two addresses by hand
(the ``manual`` provider); that works with anything that speaks DevTools.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from .environment import Environment, Field, ProjectKey, Provider, ProviderInfo, SandboxError


def pick(data: Any, path: str) -> str:
    """A value out of a JSON response, by dotted path."""
    for part in path.split("."):
        if not isinstance(data, dict):
            return ""
        data = data.get(part)
    return str(data or "")


class _Blanks(dict):
    """A field the person left empty is an empty string, not a crash."""

    def __missing__(self, key: str) -> str:
        return ""


def fill(template: Any, context: dict[str, str]) -> Any:
    """A request body or path with {placeholders} replaced; empty values drop their key."""
    if isinstance(template, str):
        return template.format_map(_Blanks(context))
    if isinstance(template, dict):
        filled = {key: fill(value, context) for key, value in template.items()}
        return {key: value for key, value in filled.items() if value not in ("", None)}
    if isinstance(template, list):
        return [fill(item, context) for item in template]
    return template


@dataclass
class Call:
    method: str
    path: str
    body: dict[str, Any] | None = None


@dataclass
class RemoteSpec:
    """One cloud service, described rather than coded."""

    info: ProviderInfo
    base: str
    auth_header: str
    auth_value: str = "{api_key}"
    create: Call = field(default_factory=lambda: Call("POST", "/"))
    cdp_field: str = ""
    live_field: str = ""
    id_field: str = "id"
    expires_field: str = ""
    profile: Call | None = None  # created once per project, so logins come back next time
    profile_id_field: str = "id"
    profile_from_create: str = ""  # some services make the profile themselves and name it in the answer
    fetch: Call | None = None  # re-read a session that is already running
    live: Call | None = None  # some services keep the picture's address behind its own request
    release: Call | None = None


class RemoteProvider(Provider):
    """Any of the described services."""

    def __init__(self, spec: RemoteSpec):
        self.spec = spec
        self.info = spec.info

    # ── requests ────────────────────────────────────────────────────────
    def _context(self, key: ProjectKey, state: dict[str, Any]) -> dict[str, str]:
        secret = {name: str(value) for name, value in (state.get("_secret") or {}).items()}
        return {**secret, "slug": key.slug, "project": key.name, "profile": str(state.get("profile") or ""),
                "session": str(state.get("session") or ""), "base": str(secret.get("base_url") or self.spec.base)}

    async def _request(self, call: Call, context: dict[str, str]) -> dict[str, Any]:
        if not context.get("api_key") and "api_key" in self.spec.auth_value:
            raise SandboxError(f"{self.info.name} 还没有填密钥")
        url = context["base"].rstrip("/") + fill(call.path, context)
        headers = {self.spec.auth_header: fill(self.spec.auth_value, context), "Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient(timeout=90, trust_env=False) as client:
                response = await client.request(call.method, url, headers=headers,
                                                json=fill(call.body, context) if call.body is not None else None)
        except httpx.HTTPError as exc:
            raise SandboxError(f"连不上 {self.info.name}：{exc}") from None
        if response.status_code >= 400:
            raise SandboxError(f"{self.info.name} 拒绝了请求（HTTP {response.status_code}）：{response.text[:200]}")
        try:
            data = response.json()
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {"items": data}

    # ── the contract ────────────────────────────────────────────────────
    async def available(self) -> tuple[bool, str]:
        return True, ""

    def _environment(self, data: dict[str, Any], state: dict[str, Any]) -> Environment:
        return Environment(
            provider=self.info.id, status="running",
            id=pick(data, self.spec.id_field) or str(state.get("session") or ""),
            cdp_url=pick(data, self.spec.cdp_field),
            live_view_url=pick(data, self.spec.live_field) if self.spec.live_field else "",
            expires_at=pick(data, self.spec.expires_field) if self.spec.expires_field else "",
            detail=self.info.name)

    async def ensure(self, key: ProjectKey, state: dict[str, Any]) -> Environment:
        if state.get("session"):
            running = await self.status(key, state)
            if running.running:
                return running
        context = self._context(key, state)
        if self.spec.profile is not None and not state.get("profile"):
            created = await self._request(self.spec.profile, context)
            state["profile"] = pick(created, self.spec.profile_id_field) or key.slug
            context = self._context(key, state)
        created = await self._request(self.spec.create, context)
        environment = self._environment(created, state)
        state["session"] = environment.id
        if self.spec.profile_from_create:
            state["profile"] = pick(created, self.spec.profile_from_create) or state.get("profile", "")
        if not environment.live_view_url:
            environment.live_view_url = await self._live(key, state)
        if not environment.cdp_url:
            raise SandboxError(f"{self.info.name} 没有返回浏览器的调试地址")
        return environment

    async def status(self, key: ProjectKey, state: dict[str, Any]) -> Environment:
        if not state.get("session") or self.spec.fetch is None:
            return Environment(provider=self.info.id, status="missing", detail=self.info.name)
        try:
            data = await self._request(self.spec.fetch, self._context(key, state))
        except SandboxError:
            return Environment(provider=self.info.id, status="missing", detail=self.info.name)
        environment = self._environment(data, state)
        if not environment.cdp_url:
            return Environment(provider=self.info.id, status="missing", detail=self.info.name)
        if not environment.live_view_url:
            environment.live_view_url = await self._live(key, state)
        return environment

    async def _live(self, key: ProjectKey, state: dict[str, Any]) -> str:
        """The picture's address, when the service hands it out separately (and it expires)."""
        if self.spec.live is None:
            return ""
        try:
            return pick(await self._request(self.spec.live, self._context(key, state)), self.spec.live_field)
        except SandboxError:
            return ""

    async def stop(self, key: ProjectKey, state: dict[str, Any]) -> None:
        """Ending the session is what writes the logins back to the profile."""
        if state.get("session") and self.spec.release is not None:
            try:
                await self._request(self.spec.release, self._context(key, state))
            except SandboxError:
                pass
        state.pop("session", None)

    async def destroy(self, key: ProjectKey, state: dict[str, Any]) -> None:
        await self.stop(key, state)
        state.pop("profile", None)


class ManualProvider(Provider):
    """Anything that speaks DevTools: the person pastes the two addresses."""

    info = ProviderInfo(
        id="manual", name="自定义（填地址）", kind="manual",
        summary="已经有自己的浏览器环境？填它的 DevTools 地址，AIOPC 就用它。任何支持 CDP 的服务都可以。",
        fields=(Field("cdp_url", "DevTools 地址", placeholder="ws://127.0.0.1:9222 或 wss://…"),
                Field("live_view_url", "画面地址（可选）", optional=True, placeholder="https://…")),
        persists_logins=False)

    async def ensure(self, key: ProjectKey, state: dict[str, Any]) -> Environment:
        secret = state.get("_secret") or {}
        cdp = str(secret.get("cdp_url") or "").strip()
        if not cdp:
            raise SandboxError("还没有填 DevTools 地址")
        return Environment(provider=self.info.id, status="running", id="manual", cdp_url=cdp,
                           live_view_url=str(secret.get("live_view_url") or "").strip(), detail="自定义环境")

    async def status(self, key: ProjectKey, state: dict[str, Any]) -> Environment:
        try:
            return await self.ensure(key, state)
        except SandboxError:
            return Environment(provider=self.info.id, status="missing", detail="自定义环境")


def _info(provider_id: str, name: str, summary: str, help_url: str, *fields: Field) -> ProviderInfo:
    return ProviderInfo(id=provider_id, name=name, kind="cloud", summary=summary, help_url=help_url,
                        fields=(Field("api_key", "API Key", secret=True), *fields))


KEY = "api_key"

REMOTE_CATALOG: tuple[RemoteSpec, ...] = (
    RemoteSpec(
        info=_info("kernel", "Kernel", "云端浏览器，按项目保存登录状态，画面可以直接嵌在 AIOPC 里。每月有免费额度。",
                   "https://www.kernel.sh/docs"),
        base="https://api.onkernel.com", auth_header="Authorization", auth_value="Bearer {api_key}",
        profile=Call("POST", "/profiles", {"name": "{slug}"}), profile_id_field="name",
        create=Call("POST", "/browsers", {"headless": False, "stealth": True,
                                          "profile": {"name": "{profile}", "save_changes": True}}),
        id_field="session_id", cdp_field="cdp_ws_url", live_field="browser_live_view_url",
        fetch=Call("GET", "/browsers/{session}"),
        release=Call("DELETE", "/browsers/{session}"),
    ),
    RemoteSpec(
        info=_info("browserbase", "Browserbase", "被最多工具集成的云端浏览器。用 Context 保存登录状态。",
                   "https://docs.browserbase.com", Field("project_id", "Project ID")),
        base="https://api.browserbase.com", auth_header="X-BB-API-Key",
        profile=Call("POST", "/v1/contexts", {"projectId": "{project_id}"}),
        create=Call("POST", "/v1/sessions", {"projectId": "{project_id}", "keepAlive": True,
                                             "browserSettings": {"context": {"id": "{profile}", "persist": True}}}),
        id_field="id", cdp_field="connectUrl",
        live=Call("GET", "/v1/sessions/{session}/debug"), live_field="debuggerFullscreenUrl",
        fetch=Call("GET", "/v1/sessions/{session}"),
        release=Call("POST", "/v1/sessions/{session}", {"projectId": "{project_id}", "status": "REQUEST_RELEASE"}),
    ),
    RemoteSpec(
        info=_info("steel", "Steel", "开源的云端浏览器，也可以自己部署（填自己的地址）。云端版按项目保存登录状态。",
                   "https://docs.steel.dev", Field("base_url", "自托管地址（可选）", optional=True,
                                                   placeholder="https://api.steel.dev")),
        base="https://api.steel.dev", auth_header="steel-api-key",
        create=Call("POST", "/v1/sessions", {"headless": False, "persistProfile": True, "profileId": "{profile}",
                                             "timeout": 1_800_000}),
        profile_from_create="profileId",
        id_field="id", cdp_field="websocketUrl", live_field="sessionViewerUrl",
        fetch=Call("GET", "/v1/sessions/{session}"),
        release=Call("POST", "/v1/sessions/{session}/release"),
    ),
    RemoteSpec(
        info=_info("hyperbrowser", "Hyperbrowser", "云端浏览器，profile 保存登录状态，画面可设为只读。",
                   "https://docs.hyperbrowser.ai"),
        base="https://api.hyperbrowser.ai", auth_header="x-api-key",
        profile=Call("POST", "/api/profile", {"name": "{slug}"}),
        create=Call("POST", "/api/session", {"profile": {"id": "{profile}", "persistChanges": True},
                                             "useStealth": True, "timeoutMinutes": 60}),
        id_field="id", cdp_field="wsEndpoint", live_field="liveUrl",
        fetch=Call("GET", "/api/session/{session}"),
        release=Call("PUT", "/api/session/{session}/stop"),
    ),
    RemoteSpec(
        info=_info("anchor", "Anchor Browser", "云端浏览器，按名字保存 profile，画面可以嵌入。",
                   "https://docs.anchorbrowser.io"),
        base="https://api.anchorbrowser.io", auth_header="anchor-api-key",
        create=Call("POST", "/v1/sessions", {"browser": {"headless": {"active": False},
                                                         "profile": {"name": "{slug}", "persist": True}}}),
        id_field="data.id", cdp_field="data.cdp_url", live_field="data.live_view_url",
        release=Call("DELETE", "/v1/sessions/{session}"),
    ),
    RemoteSpec(
        info=_info("browseruse", "Browser Use Cloud", "单价最低的云端浏览器。已有 profile 的话填 Profile ID 继续用。",
                   "https://docs.browser-use.com", Field("profile_id", "Profile ID（可选）", optional=True)),
        base="https://api.browser-use.com", auth_header="X-Browser-Use-API-Key",
        create=Call("POST", "/api/v2/browsers", {"profileId": "{profile_id}", "timeout": 60}),
        id_field="id", cdp_field="cdpUrl", live_field="liveUrl",
        fetch=Call("GET", "/api/v2/browsers/{session}"),
        release=Call("PATCH", "/api/v2/browsers/{session}", {"action": "stop"}),
    ),
)
