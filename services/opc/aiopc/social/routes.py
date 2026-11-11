"""The routes behind AIOPC's social tools: how a connected account actually gets things done.

The AI and the pages only ever call ``SocialService.publish`` / ``read``. Each
account has one or more routes, and the service takes the first that can do the
job: official APIs first, then third-party data for reading, then the built-in
browser, which every account has. Adding an official API to a platform is adding
a route here; nothing above changes.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import mimetypes
import re
import secrets
import shutil
import subprocess
import time
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from aiopc import credentials
from aiopc.platforms import MULTIPOST_KEYS

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".m4v"}


class RouteError(ValueError):
    pass


@dataclass
class Post:
    text: str
    title: str = ""
    media: list[Path] = field(default_factory=list)
    form: str = "post"
    tags: list[str] = field(default_factory=list)

    @property
    def images(self) -> list[Path]:
        return [path for path in self.media if path.suffix.lower() in IMAGE_SUFFIXES]

    @property
    def videos(self) -> list[Path]:
        return [path for path in self.media if path.suffix.lower() in VIDEO_SUFFIXES]


class Route:
    """One way of working with an account. ``kind``: browser, api or data."""

    id = ""
    kind = "browser"
    name = ""

    def attached(self, account: dict[str, Any]) -> bool:
        return False

    def publishes(self, account: dict[str, Any], post: Post) -> bool:
        return False

    async def publish(self, account: dict[str, Any], post: Post) -> dict[str, Any]:
        raise RouteError("这条路线不能发布")

    def reads(self, account: dict[str, Any], what: str) -> bool:
        return False

    async def read(self, account: dict[str, Any], what: str, post_id: str = "") -> dict[str, Any]:
        raise RouteError("这条路线不能读取")

    def describe(self, account: dict[str, Any]) -> dict[str, Any]:
        return {"id": self.id, "kind": self.kind, "name": self.name}


# ── built-in browser: every account ─────────────────────────────────────
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
    "x": {"posts": "https://x.com/{handle}", "comments": "https://x.com/notifications/mentions"},
    "github": {"posts": "https://github.com/{handle}?tab=repositories", "comments": "https://github.com/notifications"},
    "producthunt": {"posts": "https://www.producthunt.com/@{handle}"},
    "reddit": {"posts": "https://www.reddit.com/user/{handle}/submitted/", "comments": "https://www.reddit.com/message/inbox/"},
}


class BrowserRoute(Route):
    """Fills the platform's composer (MultiPost) for the person to publish; reads the account's own pages."""

    id, kind, name = "browser", "browser", "内置浏览器"

    def __init__(self, browser: Any):
        self._browser = browser

    def attached(self, account: dict[str, Any]) -> bool:
        return True

    def publishes(self, account: dict[str, Any], post: Post) -> bool:
        return post.form in MULTIPOST_KEYS.get(account["platform"], {})

    async def publish(self, account: dict[str, Any], post: Post) -> dict[str, Any]:
        result = await self._browser().compose(account["platform"], post.form, text=post.text, title=post.title,
                                               media=post.media, tags=post.tags)
        return {"status": "composer_filled", **result,
                "message": "已在内置浏览器填好发布页。请在右侧检查后点发布；发布后把链接告诉我，会记录到项目。"}

    def reads(self, account: dict[str, Any], what: str) -> bool:
        return what in PAGES.get(account["platform"], {})

    async def read(self, account: dict[str, Any], what: str, post_id: str = "") -> dict[str, Any]:
        identity = account.get("identity") or {}
        url = PAGES[account["platform"]][what].format(handle=identity.get("handle", "").lstrip("@"), id=identity.get("id", ""))
        return await self._browser().page_text(url)


# ── third-party X data (twitterapi.io): cheap reads ────────────────────
class XDataRoute(Route):
    id, kind, name = "x-data", "data", "X 第三方数据"

    def __init__(self, xdata: Any, configured: Any):
        self._xdata = xdata
        self._configured = configured

    def attached(self, account: dict[str, Any]) -> bool:
        return account["platform"] == "x" and self._configured()

    def reads(self, account: dict[str, Any], what: str) -> bool:
        return self.attached(account) and what in ("posts", "comments")

    async def read(self, account: dict[str, Any], what: str, post_id: str = "") -> dict[str, Any]:
        identity = account.get("identity") or {}
        handle = (identity.get("handle") or identity.get("name") or "").lstrip("@")
        xdata = self._xdata()
        if what == "comments":
            return xdata.replies(post_id) if post_id else xdata.mentions(handle)
        return xdata.user_posts(handle)


# ── X official API (OAuth 1.0a user keys): direct text posts ────────────
def _pct(value: str) -> str:
    return urllib.parse.quote(str(value), safe="~")


def oauth1_header(method: str, url: str, keys: dict[str, str], query: dict[str, str] | None = None, *,
                  nonce: str | None = None, timestamp: str | None = None) -> str:
    """OAuth 1.0a HMAC-SHA1 for X's user-context endpoints. JSON bodies are not signed."""
    oauth = {
        "oauth_consumer_key": keys["api_key"], "oauth_nonce": nonce or secrets.token_hex(16), "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": timestamp or str(int(time.time())), "oauth_token": keys["access_token"], "oauth_version": "1.0",
    }
    params = {**(query or {}), **oauth}
    base = "&".join([method.upper(), _pct(url), _pct("&".join(f"{_pct(k)}={_pct(v)}" for k, v in sorted(params.items())))])
    signing_key = f"{_pct(keys['api_secret'])}&{_pct(keys['access_token_secret'])}"
    oauth["oauth_signature"] = base64.b64encode(hmac.new(signing_key.encode(), base.encode(), hashlib.sha1).digest()).decode()
    return "OAuth " + ", ".join(f'{_pct(k)}="{_pct(v)}"' for k, v in sorted(oauth.items()))


def x_weighted_length(text: str) -> int:
    """X counts most CJK and emoji as two characters toward its 280 limit."""
    return sum(1 if ord(char) <= 0x10FF or 0x2000 <= ord(char) <= 0x200D or 0x2010 <= ord(char) <= 0x201F
               or 0x2032 <= ord(char) <= 0x2037 else 2 for char in text)


class XApiRoute(Route):
    id, kind, name = "x-api", "api", "X 官方接口"
    API = "https://api.x.com/2"

    def attached(self, account: dict[str, Any]) -> bool:
        return account["platform"] == "x" and self.id in (account.get("routes") or {})

    def publishes(self, account: dict[str, Any], post: Post) -> bool:
        # Text posts only; anything with media or over the limit goes through the browser.
        return self.attached(account) and post.form == "post" and not post.media and x_weighted_length(self._text(post)) <= 280

    @staticmethod
    def _text(post: Post) -> str:
        tags = " ".join(f"#{tag}" for tag in post.tags if f"#{tag}" not in post.text)
        return f"{post.text}\n\n{tags}".strip() if tags else post.text

    async def verify(self, keys: dict[str, str]) -> dict[str, str]:
        url = f"{self.API}/users/me"
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(url, headers={"Authorization": oauth1_header("GET", url, keys)})
        if response.status_code != 200:
            raise RouteError(f"X 拒绝了这组密钥（HTTP {response.status_code}）。请确认应用有读写权限，并重新生成 Access Token。")
        user = response.json().get("data") or {}
        return {"id": str(user.get("id") or ""), "username": user.get("username", ""), "name": user.get("name", "")}

    async def publish(self, account: dict[str, Any], post: Post) -> dict[str, Any]:
        keys = credentials.load(account["id"], self.id)
        if not keys:
            raise RouteError("X 官方接口的密钥不在钥匙串里，请在账号页重新添加")
        url = f"{self.API}/tweets"
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(url, json={"text": self._text(post)}, headers={"Authorization": oauth1_header("POST", url, keys)})
        if response.status_code not in (200, 201):
            raise RouteError(f"X 没有接受这条帖子（HTTP {response.status_code}）：{response.text[:200]}")
        tweet_id = (response.json().get("data") or {}).get("id", "")
        handle = (account.get("routes", {}).get(self.id, {}).get("username") or account.get("identity", {}).get("handle", "")).lstrip("@")
        return {"status": "published", "post_id": tweet_id, "url": f"https://x.com/{handle or 'i'}/status/{tweet_id}",
                "message": "已通过 X 官方接口发布。"}


# ── Bluesky (AT Protocol): open API with an app password ─────────────────
class BlueskyRoute(Route):
    id, kind, name = "bluesky-api", "api", "Bluesky 官方接口"
    SERVICE = "https://bsky.social/xrpc"
    MAX_IMAGE_BYTES = 976_560

    def __init__(self) -> None:
        self._sessions: dict[str, tuple[float, dict[str, Any]]] = {}

    def attached(self, account: dict[str, Any]) -> bool:
        return account["platform"] == "bluesky" and self.id in (account.get("routes") or {})

    async def verify(self, handle: str, app_password: str) -> dict[str, str]:
        session = await self._create_session(handle, app_password)
        return {"did": session["did"], "handle": session["handle"]}

    async def _create_session(self, handle: str, app_password: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(f"{self.SERVICE}/com.atproto.server.createSession",
                                         json={"identifier": handle.lstrip("@"), "password": app_password})
        if response.status_code != 200:
            raise RouteError("Bluesky 拒绝了登录：请确认账号和应用专用密码（设置 → 隐私与安全 → 应用专用密码）")
        return response.json()

    async def _session(self, account: dict[str, Any]) -> dict[str, Any]:
        cached = self._sessions.get(account["id"])
        if cached and time.time() - cached[0] < 30 * 60:
            return cached[1]
        secret = credentials.load(account["id"], self.id)
        if not secret:
            raise RouteError("Bluesky 的应用专用密码不在钥匙串里，请在账号页重新添加")
        session = await self._create_session(secret["handle"], secret["app_password"])
        self._sessions[account["id"]] = (time.time(), session)
        return session

    def publishes(self, account: dict[str, Any], post: Post) -> bool:
        return (self.attached(account) and post.form == "post" and not post.videos and len(post.images) <= 4
                and all(path.stat().st_size <= self.MAX_IMAGE_BYTES for path in post.images))

    @staticmethod
    def facets(text: str) -> list[dict[str, Any]]:
        """Links and #tags as rich-text facets (byte offsets, as the protocol counts them)."""
        found = []
        for match in re.finditer(r"https?://[^\s]+|(?<!\w)#[^\s#]+", text):
            start = len(text[:match.start()].encode())
            end = start + len(match.group(0).encode())
            value = match.group(0)
            feature = ({"$type": "app.bsky.richtext.facet#link", "uri": value} if value.startswith("http")
                       else {"$type": "app.bsky.richtext.facet#tag", "tag": value[1:]})
            found.append({"index": {"byteStart": start, "byteEnd": end}, "features": [feature]})
        return found

    async def publish(self, account: dict[str, Any], post: Post) -> dict[str, Any]:
        session = await self._session(account)
        headers = {"Authorization": f"Bearer {session['accessJwt']}"}
        text = XApiRoute._text(post)
        record: dict[str, Any] = {"$type": "app.bsky.feed.post", "text": text, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        if facets := self.facets(text):
            record["facets"] = facets
        async with httpx.AsyncClient(timeout=60) as client:
            images = []
            for path in post.images:
                upload = await client.post(f"{self.SERVICE}/com.atproto.repo.uploadBlob", content=path.read_bytes(),
                                           headers={**headers, "Content-Type": mimetypes.guess_type(path.name)[0] or "image/jpeg"})
                if upload.status_code != 200:
                    raise RouteError(f"Bluesky 没有接受图片 {path.name}（HTTP {upload.status_code}）")
                images.append({"alt": "", "image": upload.json()["blob"]})
            if images:
                record["embed"] = {"$type": "app.bsky.embed.images", "images": images}
            response = await client.post(f"{self.SERVICE}/com.atproto.repo.createRecord", headers=headers,
                                         json={"repo": session["did"], "collection": "app.bsky.feed.post", "record": record})
        if response.status_code != 200:
            raise RouteError(f"Bluesky 没有接受这条帖子（HTTP {response.status_code}）：{response.text[:200]}")
        uri = response.json()["uri"]
        return {"status": "published", "post_id": uri, "url": f"https://bsky.app/profile/{session['handle']}/post/{uri.rsplit('/', 1)[-1]}",
                "message": "已通过 Bluesky 官方接口发布。"}

    def reads(self, account: dict[str, Any], what: str) -> bool:
        return self.attached(account) and what in ("posts", "stats", "comments")

    async def read(self, account: dict[str, Any], what: str, post_id: str = "") -> dict[str, Any]:
        session = await self._session(account)
        headers = {"Authorization": f"Bearer {session['accessJwt']}"}
        async with httpx.AsyncClient(timeout=30) as client:
            if what == "comments":
                response = await client.get(f"{self.SERVICE}/app.bsky.notification.listNotifications", params={"limit": 50}, headers=headers)
                items = [{"reason": item.get("reason"), "author": item.get("author", {}).get("handle"),
                          "text": (item.get("record") or {}).get("text", ""), "at": item.get("indexedAt")}
                         for item in response.json().get("notifications", []) if item.get("reason") in ("reply", "mention", "quote")]
                return {"what": what, "items": items}
            response = await client.get(f"{self.SERVICE}/app.bsky.feed.getAuthorFeed", params={"actor": session["did"], "limit": 30}, headers=headers)
        posts = [{"text": (entry["post"].get("record") or {}).get("text", ""), "at": entry["post"].get("indexedAt"),
                  "likes": entry["post"].get("likeCount", 0), "reposts": entry["post"].get("repostCount", 0),
                  "replies": entry["post"].get("replyCount", 0), "quotes": entry["post"].get("quoteCount", 0),
                  "uri": entry["post"].get("uri")} for entry in response.json().get("feed", [])]
        return {"what": what, "items": posts}


# ── GitHub through the official gh CLI ─────────────────────────────────
def gh_path() -> str | None:
    """gh from PATH or Homebrew's usual places (an app opened from Finder has a minimal PATH)."""
    return shutil.which("gh") or next((path for path in ("/opt/homebrew/bin/gh", "/usr/local/bin/gh") if Path(path).exists()), None)


class GitHubCliRoute(Route):
    """Available when gh is installed and logged in; the AI also uses gh directly for repos, issues and PRs."""

    id, kind, name = "github-cli", "api", "GitHub 命令行（gh）"

    def __init__(self) -> None:
        self._status: tuple[float, bool] = (0.0, False)

    def ready(self) -> bool:
        checked, ok = self._status
        if time.time() - checked < 60:
            return ok
        gh = gh_path()
        ok = bool(gh) and subprocess.run([gh, "auth", "status"], capture_output=True, timeout=10, check=False).returncode == 0
        self._status = (time.time(), ok)
        return ok

    def attached(self, account: dict[str, Any]) -> bool:
        return account["platform"] == "github" and self.ready()

    def reads(self, account: dict[str, Any], what: str) -> bool:
        return self.attached(account) and what in ("posts", "comments")

    async def read(self, account: dict[str, Any], what: str, post_id: str = "") -> dict[str, Any]:
        path = "/notifications?per_page=30" if what == "comments" else "/users/{handle}/events?per_page=30".format(
            handle=(account.get("identity") or {}).get("handle", "").lstrip("@") or "{owner}")
        process = await asyncio.create_subprocess_exec(gh_path() or "gh", "api", path, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await process.communicate()
        if process.returncode != 0:
            raise RouteError(f"gh 调用失败：{err.decode()[:200]}")
        return {"what": what, "items": json.loads(out or b"[]")}


# What each platform can add beyond the browser: shown on the Accounts page.
ENHANCEMENTS: dict[str, list[dict[str, Any]]] = {
    "x": [{"route": "x-api", "name": "X 官方接口", "does": "确认后直接发布纯文字帖子（带图的帖子仍由浏览器填写）",
           "fields": [{"name": "api_key", "label": "API Key"}, {"name": "api_secret", "label": "API Key Secret", "secret": True},
                      {"name": "access_token", "label": "Access Token"},
                      {"name": "access_token_secret", "label": "Access Token Secret", "secret": True}],
           "help": "在 X 开发者后台创建应用，权限设为读写，然后生成 Access Token。", "help_url": "https://developer.x.com/en/portal/dashboard"}],
    "bluesky": [{"route": "bluesky-api", "name": "Bluesky 官方接口", "does": "确认后直接发帖（最多 4 张图），读回自己的帖子、数据和通知",
                 "fields": [{"name": "handle", "label": "账号（如 name.bsky.social）"},
                            {"name": "app_password", "label": "应用专用密码", "secret": True}],
                 "help": "在 Bluesky 设置 → 隐私与安全 → 应用专用密码 里新建一个。", "help_url": "https://bsky.app/settings/app-passwords"}],
    "github": [{"route": "github-cli", "name": "GitHub 命令行（gh）", "does": "AI 直接处理仓库、Issue、PR、Release 和通知",
                "fields": [], "automatic": True,
                "help": "安装 gh（在终端运行 brew install gh），再运行 gh auth login 按提示在浏览器授权；完成后自动启用。",
                "help_url": "https://cli.github.com/"}],
}
