"""The one social core for AIOPC: the AI's tools and the app's Accounts page both call this.

Every account is connected by logging in once in AIOPC's built-in browser. Behind
the same publish / read calls each account may have more routes (official APIs,
third-party data); the service picks the best one for each job, so neither the
AI nor the pages need to know which mechanism ran. Routes live in ``routes.py``.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

from aiopc import credentials
from aiopc.accounts import PLATFORMS, AccountError, AccountStore, normalize_platform
from aiopc.github import DEVICE_URL, GitHubAuth, GitHubError
from aiopc.paths import inside
from aiopc.project import Project

from .openwork import LOGIN_PAGES, MULTIPOST_KEYS, OpenWorkBrowser, OpenWorkError
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

MAX_TEXT = 20_000
MAX_MEDIA = 18
READ_KINDS = ("posts", "stats", "comments")
# Platforms whose logged-in identity we can read; others are saved as "the browser's account".
DETECTED = {"x", "xhs", "douyin", "bilibili", "tiktok", "zhihu"}
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
    def __init__(self, instance: Path, workspace: Path, *, browser: OpenWorkBrowser | None = None, xdata: Any = None):
        self.instance = Path(instance)
        self.workspace = Path(workspace)
        self.project = Project(self.workspace)
        self.store = AccountStore(self.instance)
        self._browser = browser
        self._xdata = xdata
        self.routes: list[Route] = [
            XApiRoute(), BlueskyRoute(), GitHubCliRoute(self.instance),
            XDataRoute(lambda: self.xdata, lambda: service_secret("twitterapi") is not None),
            BrowserRoute(lambda: self.browser),
        ]

    @property
    def browser(self) -> OpenWorkBrowser:
        return self._browser or OpenWorkBrowser()

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
        direct = any(route.kind == "api" and route.id != "github-cli" for route in routes)
        attached = {route.id for route in routes}
        return {
            "account_id": account["id"], "platform": platform, "platform_name": PLATFORMS.get(platform, platform),
            "name": account.get("alias") or identity.get("name") or PLATFORMS.get(platform, platform),
            "handle": identity.get("handle", ""), "url": identity.get("url", ""),
            "status": "ready" if identity.get("id") else "needs_login",
            # direct: an official API publishes after the person approves; compose: the AI fills the composer and the
            # person presses publish; browser: the AI works on the site in the built-in browser.
            "publish": "direct" if direct else "compose" if platform in MULTIPOST_KEYS else "browser",
            "forms": list(MULTIPOST_KEYS.get(platform, {})),
            "reads": sorted({what for what in READ_KINDS for route in routes if route.reads(account, what)}),
            "routes": [{"id": route.id, "kind": route.kind, "name": route.name} for route in routes],
            "enhancements": [{**item, "attached": item["route"] in attached} for item in ENHANCEMENTS.get(platform, [])],
            "services": [service for service in self.services() if service.get("platform") == platform],
            "verified_at": account.get("verified_at"),
        }

    def accounts(self) -> list[dict[str, Any]]:
        """Every connected account; accounts are shared by all projects."""
        try:
            return [self.describe(account) for account in self.store.list()]
        except AccountError as exc:
            raise SocialError(str(exc)) from None

    def _account(self, account_id: str) -> dict[str, Any]:
        try:
            return self.store.get(account_id)
        except AccountError as exc:
            raise SocialError(str(exc)) from None

    async def connect(self, platform: str, alias: str = "", check: bool = False, *, screenshot: bool = True,
                      method: str = "auto") -> dict[str, Any]:
        """Open the login page in the built-in browser, or (check=True) save whoever is logged in.
        GitHub authorizes through the GitHub CLI unless method="browser" asks for a plain browser login."""
        try:
            platform = normalize_platform(platform)
        except AccountError as exc:
            raise SocialError(str(exc)) from None
        if platform == "github" and method != "browser":
            return await self._connect_github(alias, check)
        try:
            if not check:
                handle = await self.browser.open_login(platform, screenshot=screenshot)
                return {"status": "login_opened", "platform": platform, "login_url": LOGIN_PAGES.get(platform),
                        "message": "已在右侧内置浏览器打开登录页。请在那里登录（扫码或输入密码），完成后再检查一次（check=true）。",
                        **({"screenshot": handle["screenshot"]} if handle.get("screenshot") else {})}
            found = await self.browser.account(platform)
        except OpenWorkError as exc:
            raise SocialError(str(exc)) from None
        if found is None and platform in DETECTED:
            return {"status": "not_logged_in", "platform": platform,
                    "message": "还没有检测到登录。请先在内置浏览器里完成登录再检查。"}
        found = found or {"id": f"browser-{platform}", "name": alias or f"{PLATFORMS[platform]}账号"}
        try:
            account = self.store.upsert(platform, found, alias=alias)
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
                    await self.browser.open_device_authorization(DEVICE_URL, started["code"])
                except OpenWorkError:
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
            account = self.store.upsert("github", user, alias=alias)
        except AccountError as exc:
            raise SocialError(str(exc)) from None
        return {"status": "connected", "account": self.describe(account)}

    def update(self, account_id: str, **changes: Any) -> dict[str, Any]:
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
            account = self.store.upsert(platform, identity, alias=alias)
            credentials.save(account["id"], route_id, values)
            account = self.store.set_route(account["id"], route_id, public)
        except AccountError as exc:
            raise SocialError(str(exc)) from None
        return {"status": "connected", "account": self.describe(account)}

    def remove_route(self, account_id: str, route_id: str) -> dict[str, Any]:
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
        if info["status"] != "ready":
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
        route = next((route for route in self._routes_for(account) if route.publishes(account, post)), None)
        if route is None:
            if not info["forms"]:
                raise SocialError(f"{info['platform_name']} 不能自动填写发布页；请在内置浏览器里直接操作这个网站（已保存登录）")
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
                      form: str = "post", tags: list[str] | None = None) -> dict[str, Any]:
        checked = self.check_publish(account_id, text, title, media, form, tags)
        account, info, route, post = checked["account"], checked["info"], checked["route"], checked["post"]
        digest = hashlib.sha256(post.text.encode()).hexdigest()[:12]
        try:
            result = await route.publish(account, post)
        except (OpenWorkError, RouteError) as exc:
            self._log(account, {"action": "compose", "status": "failed", "route": route.id, "text_sha": digest, "error": str(exc)})
            raise SocialError(str(exc)) from None
        if result["status"] == "published":
            self._log(account, {"action": "published", "status": "published", "route": route.id, "text_sha": digest, "url": result.get("url", "")})
        else:
            self._log(account, {"action": "compose", "status": result["status"], "route": route.id, "text_sha": digest,
                                "page_url": result.get("page_url", "")})
        return {"account": info["name"], "account_id": account["id"], "route": route.name, **result}

    def record_published(self, account_id: str, url: str, note: str = "") -> dict[str, Any]:
        account = self._account(account_id)
        if not str(url).startswith("https://"):
            raise SocialError("请提供帖子的 https 链接")
        self._log(account, {"action": "published", "status": "published", "url": url, "note": note[:500]})
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
        except (OpenWorkError, RouteError) as exc:
            raise SocialError(str(exc)) from None
        except ValueError as exc:
            raise SocialError(str(exc)) from None
        return {"account": info["name"], "what": what, "route": route.name, **data}
