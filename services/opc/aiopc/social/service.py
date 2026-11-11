"""The one social core for AIOPC: the AI's tools and the app's Accounts page both call this.

Every account works through AIOPC's built-in browser: the person logs in there
once; publishing fills the platform's composer with MultiPost's scripts and the
person presses publish. Reading prefers structured data (third-party X data,
platform APIs inside the logged-in page) and falls back to the page's text.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

from aiopc.accounts import PLATFORMS, AccountError, AccountStore, normalize_platform
from aiopc.paths import inside
from aiopc.project import Project

from .openwork import LOGIN_PAGES, MULTIPOST_KEYS, OpenWorkBrowser, OpenWorkError

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".m4v"}
MAX_TEXT = 20_000
MAX_MEDIA = 18
READ_KINDS = ("posts", "stats", "comments")
# The account's own pages, read as text when no structured source exists.
PAGES: dict[str, dict[str, str]] = {
    "xhs": {"posts": "https://creator.xiaohongshu.com/new/note-manager",
            "stats": "https://creator.xiaohongshu.com/statistics/data-analysis",
            "comments": "https://www.xiaohongshu.com/notification"},
    "zhihu": {"posts": "https://www.zhihu.com/people/{handle}/posts",
              "stats": "https://www.zhihu.com/creator/analytics/work/all",
              "comments": "https://www.zhihu.com/notifications"},
    "jike": {"posts": "https://web.okjike.com/u/{handle}", "comments": "https://web.okjike.com/notification"},
    "weibo": {"posts": "https://weibo.com/u/{id}", "comments": "https://weibo.com/comment/inbox"},
    "douyin": {"posts": "https://creator.douyin.com/creator-micro/content/manage",
               "stats": "https://creator.douyin.com/creator-micro/data-center/content"},
    "bilibili": {"posts": "https://member.bilibili.com/platform/upload-manager/article",
                 "stats": "https://member.bilibili.com/platform/data/overview"},
    "linkedin": {"posts": "https://www.linkedin.com/in/me/recent-activity/all/"},
}
# Platforms whose logged-in identity we can read; others are saved as "the browser's account".
DETECTED = {"x", "xhs", "douyin", "bilibili", "tiktok", "zhihu"}


class SocialError(ValueError):
    pass


class SocialService:
    def __init__(self, instance: Path, workspace: Path, *, browser: OpenWorkBrowser | None = None, xdata: Any = None):
        self.instance = Path(instance)
        self.workspace = Path(workspace)
        self.project = Project(self.workspace)
        self.store = AccountStore(self.instance)
        self._browser = browser
        self._xdata = xdata

    @property
    def browser(self) -> OpenWorkBrowser:
        return self._browser or OpenWorkBrowser()

    @property
    def xdata(self) -> Any:
        if self._xdata is None:
            from aiopc.xdata import XDataService
            self._xdata = XDataService(self.instance)
        return self._xdata

    # ── accounts ─────────────────────────────────────────────────────────
    def describe(self, account: dict[str, Any]) -> dict[str, Any]:
        platform = account["platform"]
        identity = account.get("identity") or {}
        return {
            "account_id": account["id"], "platform": platform, "platform_name": PLATFORMS.get(platform, platform),
            "name": account.get("alias") or identity.get("name") or PLATFORMS.get(platform, platform),
            "handle": identity.get("handle", ""), "url": identity.get("url", ""),
            "status": "ready" if identity.get("id") else "needs_login",
            # compose: the AI fills the platform's composer; browser: the AI works on the site in the built-in browser.
            "publish": "compose" if platform in MULTIPOST_KEYS else "browser",
            "forms": list(MULTIPOST_KEYS.get(platform, {})),
            "reads": (["posts", "comments"] if platform == "x" else list(PAGES.get(platform, {}))),
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

    async def connect(self, platform: str, alias: str = "", check: bool = False, *, screenshot: bool = True) -> dict[str, Any]:
        """Open the login page in the built-in browser, or (check=True) save whoever is logged in."""
        try:
            platform = normalize_platform(platform)
        except AccountError as exc:
            raise SocialError(str(exc)) from None
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

    def update(self, account_id: str, **changes: Any) -> dict[str, Any]:
        try:
            return self.describe(self.store.update(account_id, **changes))
        except AccountError as exc:
            raise SocialError(str(exc)) from None

    def remove(self, account_id: str) -> None:
        try:
            self.store.delete(account_id)
        except AccountError as exc:
            raise SocialError(str(exc)) from None

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
                      form: str = "post") -> dict[str, Any]:
        """Everything that can be checked before anything opens."""
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            raise SocialError("正文不能为空，且不超过 20000 字")
        account = self._account(account_id)
        info = self.describe(account)
        if info["status"] != "ready":
            raise SocialError(f"{info['name']} 还没有登录，请先连接这个账号")
        paths = self._media(media)
        images = [path for path in paths if path.suffix.lower() in IMAGE_SUFFIXES]
        videos = [path for path in paths if path.suffix.lower() in VIDEO_SUFFIXES]
        problems = []
        if not info["forms"]:
            raise SocialError(f"{info['platform_name']} 不能自动填写发布页；请在内置浏览器里直接操作这个网站（已保存登录）")
        if form not in info["forms"]:
            problems.append(f"{info['platform_name']} 可用的形式：{'、'.join(info['forms'])}")
        if account["platform"] == "xhs" and form == "post" and not images:
            problems.append("小红书图文至少需要一张图片")
        if form == "video" and len(videos) != 1:
            problems.append("视频形式需要正好一个视频文件")
        if form == "article" and not (title or "").strip():
            problems.append("文章需要标题")
        if problems:
            raise SocialError("；".join(problems))
        return {"account": account, "info": info, "media": paths}

    def _log(self, account: dict[str, Any], entry: dict[str, Any]) -> None:
        # The publishing log belongs to the project (workspace) the work was done in.
        root = self.project.social
        root.mkdir(parents=True, exist_ok=True)
        with (root / "log.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"at": time.time(), "account_id": account["id"], "platform": account["platform"], **entry},
                                    ensure_ascii=False) + "\n")

    async def publish(self, account_id: str, text: str, title: str = "", media: list[str] | None = None,
                      form: str = "post", tags: list[str] | None = None) -> dict[str, Any]:
        checked = self.check_publish(account_id, text, title, media, form)
        account, info = checked["account"], checked["info"]
        digest = hashlib.sha256(text.strip().encode()).hexdigest()[:12]
        try:
            result = await self.browser.compose(account["platform"], form, text=text.strip(), title=(title or "").strip(),
                                                media=checked["media"], tags=[tag.strip().lstrip("#") for tag in tags or [] if tag.strip()])
        except OpenWorkError as exc:
            self._log(account, {"action": "compose", "status": "failed", "text_sha": digest, "error": str(exc)})
            raise SocialError(str(exc)) from None
        self._log(account, {"action": "compose", "status": "composer_filled", "text_sha": digest, "page_url": result["page_url"]})
        return {"status": "composer_filled", "account": info["name"], "account_id": account["id"], **result,
                "message": "已在内置浏览器填好发布页。请在浏览器面板里检查后点发布；发布后把链接告诉我，会记录到项目。"}

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
        identity = account.get("identity") or {}
        if account["platform"] == "x":
            handle = (identity.get("handle") or identity.get("name") or "").lstrip("@")
            if what == "comments":
                data = self.xdata.replies(post_id) if post_id else self.xdata.mentions(handle)
            else:
                data = self.xdata.user_posts(handle)
            return {"account": info["name"], **data}
        url = PAGES.get(account["platform"], {}).get(what)
        if url is None:
            raise SocialError(f"{info['name']} 目前读不到“{what}”；可读：{'、'.join(info['reads']) or '无'}")
        try:
            page = await self.browser.page_text(url.format(handle=identity.get("handle", ""), id=identity.get("id", "")))
        except OpenWorkError as exc:
            raise SocialError(str(exc)) from None
        return {"account": info["name"], "what": what, **page}
