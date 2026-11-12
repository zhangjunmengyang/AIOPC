"""The one social core for AIOPC: the AI's tools and the app's Accounts page both call this.

Accounts log in inside their project's environment. Publishing only fills the
platform composer for the person to publish. Official APIs and data services
remain available for account verification and reading.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from aiopc import credentials
from aiopc.accounts import PLATFORMS, AccountError, AccountStore, normalize_platform
from aiopc.github import DEVICE_URL, GitHubAuth, GitHubError
from aiopc.paths import inside
from aiopc.project import Project
from aiopc.sandbox import SandboxError, Sandboxes

from .browser import LOGIN_PAGES, MULTIPOST_KEYS, Browser, BrowserError
from .context import LeasedBrowser, browser_owner, register_browser_manager, selected_environment
from .login import Login
from .routes import (
    ENHANCEMENTS,
    BlueskyRoute,
    BrowserRoute,
    GitHubCliRoute,
    Post,
    Route,
    RouteError,
    XApiRoute,
    XDataRoute,
)
from .sandbox_browser import SandboxBrowser

MAX_TEXT = 20_000
MAX_MEDIA = 18
READ_KINDS = ("posts", "stats", "comments")
# Platforms whose logged-in identity we can read; others are saved as "the browser's account".
# Platforms where AIOPC can tell who is logged in; elsewhere it can only trust that the person did log in.
DETECTED = {"x", "xhs", "douyin", "bilibili", "tiktok", "zhihu", "wechat", "discord"}
# Shared data services configured on the Accounts page (not tied to one account).
SERVICES: dict[str, dict[str, Any]] = {
    "twitterapi": {
        "id": "twitterapi", "name": "X 第三方数据（twitterapi.io）",
        "does": "读取 X：搜索、竞品主页、帖子回复与提及、刷新帖子数据。按条计费，比官方便宜，结果本地缓存。",
        "fields": [{"name": "api_key", "label": "API Key", "secret": True}],
        "help": "在 twitterapi.io 注册并充值后，在后台复制 API Key。", "help_url": "https://twitterapi.io/dashboard",
        "env": "TWITTERAPI_IO_KEY", "platform": "x",
    },
}
# Routes are tried in this order: official APIs, third-party data, then the browser.
KIND_ORDER = {"api": 0, "data": 1, "browser": 2}


class SocialError(ValueError):
    pass


# One GitHub authorization per AIOPC home: it outlives a single request while the person approves.
_github_auth: dict[str, GitHubAuth] = {}


def github_auth(home: Path) -> GitHubAuth:
    key = str(Path(home).resolve())
    if key not in _github_auth:
        _github_auth[key] = GitHubAuth(Path(home))
    return _github_auth[key]


def service_secret(service: str) -> dict[str, Any] | None:
    """A shared service's key: the Keychain (set on the Accounts page), else the .env variable."""
    stored = credentials.load("service", service)
    if stored:
        return stored
    env = SERVICES.get(service, {}).get("env")
    value = os.environ.get(env, "").strip() if env else ""
    return {"api_key": value} if value else None


class SocialService:
    def __init__(self, instance: Path, workspace: Path, *, browser: Browser | None = None, xdata: Any = None,
                 sandboxes: Sandboxes | None = None, browser_factory=None):
        self.instance = Path(instance)
        self.sandboxes = sandboxes or Sandboxes(self.instance)
        self.workspace = Path(workspace)
        self.project = Project(self.workspace)
        self.store = AccountStore(self.instance)
        self._browser = browser
        self._xdata = xdata
        self._browser_factory = browser_factory or SandboxBrowser
        self._logins: dict[tuple, dict] = {}
        self.routes: list[Route] = [
            XApiRoute(), BlueskyRoute(), GitHubCliRoute(self.instance),
            XDataRoute(lambda: self.xdata, lambda: service_secret("twitterapi") is not None),
            BrowserRoute(self.browser_for),
        ]

    # ── where this project's browser runs ───────────────────────────────
    @property
    def project_path(self) -> str:
        return str(self.workspace)

    def binding(self, environment: str = "", account: dict | None = None) -> dict | None:
        selected = environment or selected_environment()
        stored = str((account or {}).get("environment") or "")
        if selected and stored and selected != stored:
            raise SocialError("所选环境与账号保存的环境不一致")
        if self._browser is not None:
            return None  # Injected test transport; production always resolves a pool resource.
        try:
            return self.sandboxes.resolve(self.project_path, stored or selected)
        except SandboxError as exc:
            raise SocialError(str(exc)) from None

    async def browser(self, environment: str = "") -> Browser:
        if self._browser is not None:
            return self._browser
        record = self.binding(environment)
        owner = browser_owner()
        register_browser_manager(self.sandboxes.leases)
        if str(Path(owner.get("projectDirectory") or "").resolve()) != str(self.workspace.resolve()):
            raise SocialError("浏览器操作与会话所属项目不一致")
        async with self.sandboxes.leases.operation(record["id"], owner, record["bindingRevision"]):
            status = await self.sandboxes.ensure(self.project_path, record["id"])
        return LeasedBrowser(self._browser_factory(status.cdp_url), self.sandboxes.leases, record, owner)

    async def browser_for(self, account: dict[str, Any]) -> Browser:
        record = self.binding(account=account)
        return await self.browser(record["id"] if record else "")

    @asynccontextmanager
    async def _browser_operation(self, browser):
        if isinstance(browser, LeasedBrowser):
            async with browser.operation() as lease:
                yield lease
        else:
            yield {}

    async def environment(self, environment: str = "") -> dict[str, Any]:
        record = self.binding(environment)
        if record:
            return {**await self.sandboxes.describe_environment(record["id"]),
                    "providers": await self.sandboxes.describe_providers()}
        return (await self.sandboxes.status(self.project_path)).describe()

    async def start_environment(self, environment: str = "") -> dict[str, Any]:
        await self.browser(environment)
        return await self.environment(environment)

    def _login_key(self, environment: str = "") -> tuple:
        record = self.binding(environment)
        if record is None:
            return ("test",)
        owner = browser_owner()
        return (record["id"], owner["runtimeId"], owner["sessionId"], owner.get("kind", "automation"))

    def _active_login(self, environment: str = "") -> dict:
        entry = self._logins.get(self._login_key(environment))
        if entry is None:
            raise SocialError("还没有为此会话打开这个环境的登录页，先调用 login_open")
        browser = entry["browser"]
        if isinstance(browser, LeasedBrowser) and self.sandboxes.get(browser.environment_id)["bindingRevision"] != browser.record["bindingRevision"]:
            self._logins.pop(self._login_key(environment), None)
            raise SocialError("登录环境的绑定已经变化，请重新打开登录页")
        return entry

    @staticmethod
    def _wait_login(browser, lease):
        if isinstance(browser, LeasedBrowser) and browser.owner.get("kind") != "human":
            browser.wait(lease["leaseId"])

    async def login_open(self, platform: str, environment: str = "") -> dict[str, Any]:
        try:
            platform = normalize_platform(platform)
        except AccountError as exc:
            raise SocialError(str(exc)) from None
        url = LOGIN_PAGES.get(platform)
        if url is None:
            raise SocialError(f"{PLATFORMS.get(platform, platform)} 还没有登录入口")
        key = self._login_key(environment)
        browser = await self.browser(environment)
        async with self._browser_operation(browser) as lease:
            try:
                found = await browser.account(platform)
            except BrowserError:
                found = None
            env_id = browser.environment_id if isinstance(browser, LeasedBrowser) else None
            if found:
                account = self.store.upsert(platform, found, project=self.project_path, environment=env_id)
                return {"platform": platform, "status": "already_connected", "environment": env_id,
                        "account": self.describe(account), "message": f"这个环境已经登录了 {found.get('name') or platform}。"}
            if previous := self._logins.pop(key, None):
                old = previous["browser"]
                if not isinstance(old, LeasedBrowser) or old.record["bindingRevision"] == browser.record["bindingRevision"]:
                    await previous["login"].close()
            login = Login(browser)
            self._logins[key] = {"login": login, "platform": platform, "browser": browser}
            try:
                page, qr = await login.open(url), await login.qr_code()
            except BrowserError as exc:
                raise SocialError(str(exc)) from None
            self._wait_login(browser, lease)
            return {"platform": platform, "environment": env_id, **page, "qr_code": qr}

    async def login_look(self, environment: str = "") -> dict[str, Any]:
        entry = self._active_login(environment)
        async with self._browser_operation(entry["browser"]) as lease:
            try:
                page = await entry["login"].settle(seconds=8)
                qr = await entry["login"].qr_code()
            except BrowserError as exc:
                raise SocialError(str(exc)) from None
            self._wait_login(entry["browser"], lease)
            return {"platform": entry["platform"], **page, "qr_code": qr}

    async def _login_action(self, action: str, *args, environment: str = ""):
        entry = self._active_login(environment)
        async with self._browser_operation(entry["browser"]) as lease:
            try:
                result = await getattr(entry["login"], action)(*args)
                if action in {"fill", "click"}:
                    result = await entry["login"].read()
            except BrowserError as exc:
                raise SocialError(str(exc)) from None
            self._wait_login(entry["browser"], lease)
            return result

    async def login_fill(self, label: str, value: str, environment: str = "") -> dict[str, Any]:
        return await self._login_action("fill", label, value, environment=environment)

    async def login_click(self, text: str, environment: str = "") -> dict[str, Any]:
        return await self._login_action("click", text, environment=environment)

    async def login_screenshot(self, environment: str = "") -> str:
        return await self._login_action("screenshot", environment=environment)

    async def login_finish(self, alias: str = "", environment: str = "") -> dict[str, Any]:
        entry = self._active_login(environment)
        browser = entry["browser"]
        async with self._browser_operation(browser) as lease:
            result = await self.connect(entry["platform"], alias, check=True, screenshot=False, environment=environment)
            if result.get("status") == "connected":
                await entry["login"].close()
                self._logins.pop(self._login_key(environment), None)
            else:
                self._wait_login(browser, lease)
        if result.get("status") == "connected" and isinstance(browser, LeasedBrowser):
            browser.manager.release(browser.environment_id, browser.owner, lease["leaseId"])
        return result


    @property
    def xdata(self) -> Any:
        if self._xdata is None:
            from aiopc.xdata import XDataService

            self._xdata = XDataService(self.instance)
        return self._xdata

    def _routes_for(self, account: dict[str, Any]) -> list[Route]:
        return sorted((route for route in self.routes if route.attached(account)), key=lambda route: KIND_ORDER[route.kind])

    # ── accounts ─────────────────────────────────────────────────────────
    def describe(self, account: dict[str, Any]) -> dict[str, Any]:
        platform = account["platform"]
        identity = account.get("identity") or {}
        routes = self._routes_for(account)
        attached = {route.id for route in routes}
        return {
            "account_id": account["id"], "platform": platform, "platform_name": PLATFORMS.get(platform, platform),
            "environment": account.get("environment"),
            "name": account.get("alias") or identity.get("name") or PLATFORMS.get(platform, platform),
            "handle": identity.get("handle", ""), "url": identity.get("url", ""),
            # ready: AIOPC saw who is logged in; unverified: a platform it cannot check, taken on the person's word.
            "status": ("needs_login" if not identity.get("id") or account.get("logged_in") is False
                       else "ready" if platform in DETECTED or account.get("routes") else "unverified"),
            "checked_at": account.get("checked_at"),
            "publish": "compose" if platform in MULTIPOST_KEYS else "browser",
            "forms": list(MULTIPOST_KEYS.get(platform, {})),
            "reads": sorted({what for what in READ_KINDS for route in routes if route.reads(account, what)}),
            "routes": [{"id": route.id, "kind": route.kind,
                        "name": route.name} for route in routes],
            "enhancements": [{**item, "attached": item["route"] in attached} for item in ENHANCEMENTS.get(platform, [])],
            "services": [service for service in self.services() if service.get("platform") == platform],
            "verified_at": account.get("verified_at"),
        }

    def accounts(self) -> list[dict[str, Any]]:
        """The accounts this project can use: the ones whose login lives where its browser runs."""
        try:
            saved = self.store.list()
        except AccountError as exc:
            raise SocialError(str(exc)) from None
        here = [account for account in saved if str(account.get("project") or "") == self.project_path]
        return [self.describe(account) for account in here]

    async def check_logins(self, *, max_age: float = 600) -> dict[str, Any]:
        """Look again at whether each account here is still logged in, where AIOPC can tell.
        Accounts checked within ``max_age`` seconds are left alone, so opening the page often stays cheap."""
        due = [account for account in self.store.list()
               if account["platform"] in DETECTED and str(account.get("project") or "") == self.project_path
               and (not selected_environment() or account.get("environment") == selected_environment())
               and time.time() - float(account.get("checked_at") or 0) > max_age]
        if not due:
            return {"checked": []}
        checked = []
        for account in due:
            browser = await self.browser_for(account)
            async with self._browser_operation(browser):
                found = None
                for _ in range(2):
                    try:
                        found = await browser.account(account["platform"])
                    except BrowserError:
                        found = None
                    if found:
                        break
                old_id = str((account.get("identity") or {}).get("id") or "")
                same = bool(found) and str(found.get("id")) == old_id
                if found and not same:
                    # A different identity is logged in there now: that is its own account.
                    self.store.upsert(account["platform"], found, alias=account.get("alias") or "",
                                      project=self.project_path, environment=account.get("environment"))
                    if old_id.startswith("browser-"):
                        # The old record only stood in for "someone is logged in"; now we know who, so it goes.
                        self.store.delete(account["id"])
                        checked.append({"platform": account["platform"], "logged_in": True})
                        continue
                self.store.mark_checked(account["id"], same)
                checked.append({"platform": account["platform"], "logged_in": same})
        return {"checked": checked}

    def _account(self, account_id: str) -> dict[str, Any]:
        try:
            account = self.store.get(account_id)
        except AccountError as exc:
            raise SocialError(str(exc)) from None
        if str(account.get("project") or "") != self.project_path:
            raise SocialError("这个账号不属于当前项目")
        return account

    async def connect(self, platform: str, alias: str = "", check: bool = False, *, screenshot: bool = True,
                      method: str = "auto", environment: str = "") -> dict[str, Any]:
        """Open the login page in the project's environment, or (check=True) save whoever is logged in.
        GitHub authorizes through the GitHub CLI unless method="browser" asks for a plain browser login."""
        try:
            platform = normalize_platform(platform)
        except AccountError as exc:
            raise SocialError(str(exc)) from None
        if platform == "github" and method == "auto":
            return await self._connect_github(alias, check)
        browser = await self.browser(environment)
        async with self._browser_operation(browser) as lease:
            try:
                if not check:
                    handle = await browser.open_login(platform, screenshot=screenshot)
                    self._wait_login(browser, lease)
                    return {"status": "login_opened", "platform": platform, "login_url": LOGIN_PAGES.get(platform),
                            "message": "已在项目环境里打开登录页。登录完成后再检查一次（check=true）。",
                            **({"screenshot": handle["screenshot"]} if handle.get("screenshot") else {})}
                found = await browser.account(platform)
            except BrowserError as exc:
                raise SocialError(str(exc)) from None
            if found is None and platform in DETECTED:
                self._wait_login(browser, lease)
                return {"status": "not_logged_in", "platform": platform,
                        "message": "还没有检测到登录。请先在项目环境里完成登录再检查。"}
            found = found or {"id": f"browser-{platform}", "name": alias or f"{PLATFORMS[platform]}账号"}
            try:
                account = self.store.upsert(platform, found, alias=alias, project=self.project_path,
                                            environment=browser.environment_id if isinstance(browser, LeasedBrowser) else None)
            except AccountError as exc:
                raise SocialError(str(exc)) from None
            return {"status": "connected", "account": self.describe(account)}

    async def _connect_github(self, alias: str, check: bool) -> dict[str, Any]:
        """GitHub connects through the official GitHub CLI: AIOPC installs it and runs its browser authorization."""
        auth = github_auth(self.instance)
        try:
            user = await auth.user()
            if user is None and not check:
                started = await auth.start()
                try:
                    await (await self.browser()).open_device_authorization(DEVICE_URL, started["code"])
                except BrowserError:
                    pass
                return {"status": "authorize", "platform": "github", "code": started["code"], "url": DEVICE_URL,
                        "message": f"已在右侧打开 GitHub 授权页，验证码 {started['code']}。请在页面上确认授权，完成后会自动识别。"}
        except GitHubError as exc:
            raise SocialError(str(exc)) from None
        if user is None:
            state = auth.state()
            if state == "failed":
                raise SocialError(auth.error or "GitHub 授权没有完成，请重新连接")
            return {"status": "not_logged_in", "platform": "github", "message": "还在等待你在 GitHub 页面上确认授权。"}
        try:
            account = self.store.upsert("github", user, alias=alias, project=self.project_path)
        except AccountError as exc:
            raise SocialError(str(exc)) from None
        return {"status": "connected", "account": self.describe(account)}

    def update(self, account_id: str, **changes: Any) -> dict[str, Any]:
        self._account(account_id)
        try:
            return self.describe(self.store.update(account_id, **changes))
        except AccountError as exc:
            raise SocialError(str(exc)) from None

    def remove(self, account_id: str) -> None:
        account = self._account(account_id)
        for route_id in (account.get("routes") or {}):
            credentials.delete(account_id, route_id)
        try:
            self.store.delete(account_id)
        except AccountError as exc:
            raise SocialError(str(exc)) from None

    # ── routes: official APIs added to an account ───────────────────────
    @staticmethod
    async def _verify_route(platform: str, route_id: str, fields: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, str]]:
        """Check the person's keys with the platform. Returns the route's public details, the account identity, and the secret."""
        if route_id not in {item["route"] for item in ENHANCEMENTS.get(platform, []) if not item.get("automatic")}:
            raise SocialError("这个平台没有这种接口")
        values = {key: str(value).strip() for key, value in (fields or {}).items() if str(value).strip()}
        try:
            if route_id == "x-api":
                if any(not values.get(name) for name in ("api_key", "api_secret", "access_token", "access_token_secret")):
                    raise SocialError("请填写全部四项密钥")
                user = await XApiRoute().verify(values)
                identity = {"id": user["id"], "name": user["name"] or user["username"], "handle": user["username"],
                            "url": f"https://x.com/{user['username']}"}
                return {"username": user["username"]}, identity, values
            if not values.get("handle") or not values.get("app_password"):
                raise SocialError("请填写账号和应用专用密码")
            session = await BlueskyRoute().verify(values["handle"], values["app_password"])
            values["handle"] = session["handle"]
            identity = {"id": session["did"], "name": session["handle"], "handle": session["handle"],
                        "url": f"https://bsky.app/profile/{session['handle']}"}
            return session, identity, values
        except RouteError as exc:
            raise SocialError(str(exc)) from None

    async def add_route(self, account_id: str, route_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        """Verify the person's keys with the platform, keep them in the Keychain, and attach the route."""
        account = self._account(account_id)
        public, _, values = await self._verify_route(account["platform"], route_id, fields)
        credentials.save(account_id, route_id, values)
        try:
            return self.describe(self.store.set_route(account_id, route_id, public))
        except AccountError as exc:
            raise SocialError(str(exc)) from None

    async def connect_with_route(self, platform: str, route_id: str, fields: dict[str, Any], alias: str = "") -> dict[str, Any]:
        """Connect an account through an official API alone: the keys say who the account is."""
        try:
            platform = normalize_platform(platform)
        except AccountError as exc:
            raise SocialError(str(exc)) from None
        public, identity, values = await self._verify_route(platform, route_id, fields)
        try:
            account = self.store.upsert(platform, identity, alias=alias, project=self.project_path)
            credentials.save(account["id"], route_id, values)
            account = self.store.set_route(account["id"], route_id, public)
        except AccountError as exc:
            raise SocialError(str(exc)) from None
        return {"status": "connected", "account": self.describe(account)}

    def remove_route(self, account_id: str, route_id: str) -> dict[str, Any]:
        self._account(account_id)
        credentials.delete(account_id, route_id)
        try:
            return self.describe(self.store.set_route(account_id, route_id, None))
        except AccountError as exc:
            raise SocialError(str(exc)) from None

    # ── shared data services (e.g. third-party X data) ──────────────────
    def services(self) -> list[dict[str, Any]]:
        listed = []
        for service in SERVICES.values():
            stored = credentials.load("service", service["id"])
            from_env = bool(service.get("env") and os.environ.get(service["env"], "").strip())
            listed.append({key: value for key, value in service.items() if key != "env"}
                          | {"configured": bool(stored) or from_env, "source": "keychain" if stored else "env" if from_env else None})
        return listed

    async def configure_service(self, service_id: str, fields: dict[str, Any] | None) -> list[dict[str, Any]]:
        if service_id not in SERVICES:
            raise SocialError("没有这个数据服务")
        values = {key: str(value).strip() for key, value in (fields or {}).items() if str(value).strip()}
        if values:
            credentials.save("service", service_id, values)
        else:
            credentials.delete("service", service_id)
        self._xdata = None
        return self.services()

    # ── publish ──────────────────────────────────────────────────────────
    def _media(self, media: list[str] | None) -> list[Path]:
        paths = []
        for item in media or []:
            path = inside(item, self.workspace, [self.workspace, self.instance / "media"])
            if path is None or not path.is_file():
                raise SocialError(f"媒体文件需在工作区内：{item}")
            paths.append(path)
        if len(paths) > MAX_MEDIA:
            raise SocialError(f"最多 {MAX_MEDIA} 个媒体文件")
        return paths

    def check_publish(self, account_id: str, text: str, title: str = "", media: list[str] | None = None,
                      form: str = "post", tags: list[str] | None = None) -> dict[str, Any]:
        """Everything that can be checked before anything opens, and the route that will run."""
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            raise SocialError("正文不能为空，且不超过 20000 字")
        account = self._account(account_id)
        info = self.describe(account)
        if info["status"] == "needs_login":
            raise SocialError(f"{info['name']} 还没有登录，请先连接这个账号")
        post = Post(text=text.strip(), title=(title or "").strip(), media=self._media(media), form=form,
                    tags=[tag.strip().lstrip("#") for tag in tags or [] if tag.strip()])
        problems = []
        if account["platform"] == "xhs" and form == "post" and not post.images:
            problems.append("小红书图文至少需要一张图片")
        if form == "video" and len(post.videos) != 1:
            problems.append("视频形式需要正好一个视频文件")
        if form == "article" and not post.title:
            problems.append("文章需要标题")
        if problems:
            raise SocialError("；".join(problems))
        route = next((route for route in self._routes_for(account) if route.kind == "browser" and route.publishes(account, post)), None)
        if route is None:
            if not info["forms"]:
                raise SocialError(f"{info['platform_name']} 不能自动填写发布页；请直接在网站上操作（登录已保存在项目环境里）")
            raise SocialError(f"{info['platform_name']} 可用的形式：{'、'.join(info['forms'])}")
        return {"account": account, "info": info, "post": post, "route": route}

    def _log(self, account: dict[str, Any], entry: dict[str, Any]) -> None:
        # The publishing log belongs to the project (workspace) the work was done in.
        root = self.project.social
        root.mkdir(parents=True, exist_ok=True)
        with (root / "log.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"at": time.time(), "account_id": account["id"], "platform": account["platform"], **entry},
                                    ensure_ascii=False) + "\n")

    async def publish(self, account_id: str, text: str, title: str = "", media: list[str] | None = None,
                      form: str = "post", tags: list[str] | None = None, *, audit_session_id: str = "") -> dict[str, Any]:
        checked = self.check_publish(account_id, text, title, media, form, tags)
        account, info, route, post = checked["account"], checked["info"], checked["route"], checked["post"]
        digest = hashlib.sha256(post.text.encode()).hexdigest()[:12]
        origin = {"session_id": audit_session_id} if audit_session_id else {}
        try:
            result = await route.publish(account, post)
        except (BrowserError, RouteError) as exc:
            self._log(account, {"action": "compose", "status": "failed", "route": route.id, "text_sha": digest, "error": str(exc), **origin})
            raise SocialError(str(exc)) from None
        if result["status"] == "published":
            self._log(account, {"action": "published", "status": "published", "route": route.id, "text_sha": digest, "url": result.get("url", ""), **origin})
        else:
            self._log(account, {"action": "compose", "status": result["status"], "route": route.id, "text_sha": digest,
                                "page_url": result.get("page_url", ""), **origin})
        return {"account": info["name"], "account_id": account["id"], "route": route.name, **result}

    def record_published(self, account_id: str, url: str, note: str = "", *, audit_session_id: str = "") -> dict[str, Any]:
        account = self._account(account_id)
        if not str(url).startswith("https://"):
            raise SocialError("请提供帖子的 https 链接")
        origin = {"session_id": audit_session_id} if audit_session_id else {}
        self._log(account, {"action": "published", "status": "published", "url": url, "note": note[:500], **origin})
        return {"recorded": True, "account": self.describe(account)["name"], "url": url}

    def history(self, limit: int = 50) -> list[dict[str, Any]]:
        path = self.project.social / "log.jsonl"
        if not path.is_file():
            return []
        lines = path.read_text(encoding="utf-8").splitlines()[-max(1, min(limit, 500)):]
        return [json.loads(line) for line in reversed(lines) if line.strip()]

    # ── read ─────────────────────────────────────────────────────────────
    async def read(self, account_id: str, what: str = "posts", post_id: str = "") -> dict[str, Any]:
        if what not in READ_KINDS:
            raise SocialError(f"what 取 {'、'.join(READ_KINDS)}")
        account = self._account(account_id)
        info = self.describe(account)
        route = next((route for route in self._routes_for(account) if route.reads(account, what)), None)
        if route is None:
            raise SocialError(f"{info['name']} 目前读不到“{what}”；可读：{'、'.join(info['reads']) or '无'}")
        try:
            data = await route.read(account, what, post_id)
        except (BrowserError, RouteError) as exc:
            raise SocialError(str(exc)) from None
        except ValueError as exc:
            raise SocialError(str(exc)) from None
        return {"account": info["name"], "what": what, "route": route.name, **data}
