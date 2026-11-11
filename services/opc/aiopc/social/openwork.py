"""Drive OpenWork's built-in browser: open a tab, inject MultiPost, read pages.

OpenWork (MIT) owns the browser and its logins; MultiPost (Apache-2.0) owns the
per-platform composer scripts. This module only connects the two: it asks
OpenWork for a protected tab through its local control bridge, then runs the
bundled MultiPost script in that tab over DevTools. Nothing is ever published:
the person reviews the filled composer in OpenWork and presses the button.
"""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import os
from pathlib import Path
from typing import Any

import httpx

HERE = Path(__file__).resolve().parent
BUNDLE = HERE / "multipost" / "dist" / "multipost.js"
# AIOPC first; the upstream OpenWork app is a fallback while both are installed.
DISCOVERY_CANDIDATES = [Path.home() / "Library/Application Support" / name / "openwork-ui-control.json"
                        for name in ("com.aiopc.desktop", "com.differentai.openwork")]
MAX_MEDIA_BYTES = 60 * 1024 * 1024

# Our platform ids → MultiPost keys by form.
MULTIPOST_KEYS: dict[str, dict[str, str]] = {
    "xhs": {"post": "DYNAMIC_REDNOTE", "video": "VIDEO_REDNOTE"},
    "zhihu": {"post": "DYNAMIC_ZHIHU", "article": "ARTICLE_ZHIHU", "video": "VIDEO_ZHIHU"},
    "jike": {"post": "DYNAMIC_OKJIKE", "video": "VIDEO_OKJIKE"},
    "x": {"post": "DYNAMIC_X", "article": "ARTICLE_XARTICLE"},
    "weibo": {"post": "DYNAMIC_WEIBO", "article": "ARTICLE_WEIBO", "video": "VIDEO_WEIBO"},
    "douyin": {"post": "DYNAMIC_DOUYIN", "video": "VIDEO_DOUYIN"},
    "bilibili": {"post": "DYNAMIC_BILIBILI", "article": "ARTICLE_BILIBILI", "video": "VIDEO_BILIBILI"},
    "kuaishou": {"video": "VIDEO_KUAISHOU"},
    "wechat": {"article": "ARTICLE_WEIXIN"},
    "channels": {"post": "DYNAMIC_WEIXINCHANNEL", "video": "VIDEO_WEIXINCHANNEL"},
    "linkedin": {"post": "DYNAMIC_LINKEDIN"},
    "threads": {"post": "DYNAMIC_THREADS"},
    "bluesky": {"post": "DYNAMIC_BLUESKY", "video": "VIDEO_BLUESKY"},
    "juejin": {"post": "DYNAMIC_JUEJIN", "article": "ARTICLE_JUEJIN"},
    "toutiao": {"post": "DYNAMIC_TOUTIAO", "article": "ARTICLE_TOUTIAO"},
    "youtube": {"video": "VIDEO_YOUTUBE"},
    "tiktok": {"video": "VIDEO_TIKTOK"},
}


# Where each platform's "who is logged in" check runs (its own origin) and where to log in.
ACCOUNT_PAGES = {
    "x": "https://x.com/home", "xhs": "https://www.xiaohongshu.com/explore", "douyin": "https://creator.douyin.com",
    "bilibili": "https://t.bilibili.com", "tiktok": "https://www.tiktok.com", "zhihu": "https://www.zhihu.com",
}
LOGIN_PAGES = {
    "x": "https://x.com/i/flow/login", "xhs": "https://creator.xiaohongshu.com/login", "zhihu": "https://www.zhihu.com/signin",
    "jike": "https://web.okjike.com/login", "weibo": "https://weibo.com/login.php", "douyin": "https://creator.douyin.com",
    "bilibili": "https://passport.bilibili.com/login", "kuaishou": "https://cp.kuaishou.com", "wechat": "https://mp.weixin.qq.com/",
    "channels": "https://channels.weixin.qq.com/login.html", "linkedin": "https://www.linkedin.com/login",
    "threads": "https://www.threads.net/login", "bluesky": "https://bsky.app/", "juejin": "https://juejin.cn/login",
    "toutiao": "https://mp.toutiao.com/", "youtube": "https://studio.youtube.com/", "tiktok": "https://www.tiktok.com/login",
}


class OpenWorkError(RuntimeError):
    pass


def multipost_key(platform: str, form: str) -> str:
    key = MULTIPOST_KEYS.get(platform, {}).get(form)
    if key is None:
        forms = "、".join(MULTIPOST_KEYS.get(platform, {})) or "无"
        raise OpenWorkError(f"{platform} 不支持“{form}”形式；可用：{forms}")
    return key


class OpenWorkBrowser:
    """AIOPC's built-in browser: pages open as tabs in the panel beside the conversation
    on screen (or beside the app page, such as Accounts, when there is none)."""

    def __init__(self, discovery: Path | None = None):
        configured = os.environ.get("OPENWORK_UI_CONTROL_DISCOVERY") or discovery
        self.discovery = Path(configured) if configured else next(
            (path for path in DISCOVERY_CANDIDATES if path.is_file()), DISCOVERY_CANDIDATES[0])

    def _bridge(self) -> tuple[str, str]:
        try:
            data = json.loads(self.discovery.read_text(encoding="utf-8"))
            return data["baseUrl"], data["token"]
        except (OSError, ValueError, KeyError):
            raise OpenWorkError("没有找到运行中的 AIOPC。请先打开 AIOPC 桌面应用。") from None

    async def execute(self, action_id: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        base, token = self._bridge()
        try:
            async with httpx.AsyncClient(timeout=60, trust_env=False) as client:
                response = await client.post(f"{base}/execute", json={"actionId": action_id, "args": args or {}},
                                             headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError:
            raise OpenWorkError("AIOPC 没有响应；确认它正在运行。") from None
        if response.status_code == 401:
            raise OpenWorkError("AIOPC 拒绝了控制请求；重启 AIOPC 后再试。")
        data = response.json()
        result = data.get("result", data) if isinstance(data, dict) else {}
        if isinstance(result, dict) and result.get("ok") is False:
            raise OpenWorkError(str(result.get("error") or "AIOPC 执行失败"))
        return result if isinstance(result, dict) else {}

    async def open(self, url: str) -> dict[str, Any]:
        handle = await self.execute("browser.open_url", {"url": url, "provider": "builtin"})
        if not handle.get("target_id") or not handle.get("browser_url"):
            raise OpenWorkError("AIOPC 没有返回浏览器标签。如果出现“是否允许访问该网站”，请在 AIOPC 里允许后重试。")
        return handle

    async def release(self, handle: dict[str, Any]) -> None:
        try:
            await self.execute("browser.release_tab", {"tab_id": handle.get("tab_id")})
        except OpenWorkError:
            pass

    async def _socket_url(self, handle: dict[str, Any]) -> str:
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            targets = (await client.get(handle["browser_url"].rstrip("/") + "/json/list")).json()
        target = next((item for item in targets if item.get("id") == handle["target_id"]), None)
        if target is None:
            raise OpenWorkError("浏览器标签已关闭")
        return target["webSocketDebuggerUrl"]

    async def evaluate(self, handle: dict[str, Any], expression: str, *, timeout: float = 120) -> Any:
        import websockets

        async with websockets.connect(await self._socket_url(handle), max_size=None) as socket:
            await socket.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
                "expression": expression, "awaitPromise": True, "returnByValue": True, "userGesture": True}}))
            async with asyncio.timeout(timeout):
                while True:
                    message = json.loads(await socket.recv())
                    if message.get("id") == 1:
                        break
        result = message.get("result", {})
        if "exceptionDetails" in result:
            detail = result["exceptionDetails"]
            raise OpenWorkError("页面脚本出错：" + str((detail.get("exception") or {}).get("description") or detail.get("text"))[:500])
        return result.get("result", {}).get("value")

    async def wait_loaded(self, handle: dict[str, Any], seconds: float = 30) -> str:
        for _ in range(int(seconds * 2)):
            state = await self.evaluate(handle, "document.readyState + '|' + location.href")
            if state and state.startswith("complete"):
                return state.split("|", 1)[1]
            await asyncio.sleep(0.5)
        return ""

    async def compose(self, platform: str, form: str, *, text: str, title: str = "", media: list[Path] | tuple[Path, ...] = (),
                      tags: list[str] | tuple[str, ...] = ()) -> dict[str, Any]:
        key = multipost_key(platform, form)
        info = json.loads((BUNDLE.parent / "platforms.json").read_text())[key]
        files, entries, total = {}, [], 0
        for index, path in enumerate(media):
            raw = Path(path).read_bytes()
            total += len(raw)
            if total > MAX_MEDIA_BYTES:
                raise OpenWorkError("媒体总大小超过 60 MB；请压缩后再试")
            name = f"{index:02d}-{Path(path).name}"
            kind = mimetypes.guess_type(name)[0] or "application/octet-stream"
            files[name] = {"b64": base64.b64encode(raw).decode(), "type": kind}
            entries.append({"name": name, "url": "opc-file:" + name, "type": kind, "size": len(raw)})
        images = [entry for entry in entries if entry["type"].startswith("image/")]
        videos = [entry for entry in entries if entry["type"].startswith("video/")]
        if info["type"] == "ARTICLE":
            data = {"title": title, "digest": text[:120], "markdownContent": text, "htmlContent": _paragraphs(text),
                    "cover": images[0] if images else None, "images": images, "tags": list(tags)}
        elif info["type"] == "VIDEO":
            data = {"title": title, "content": text, "video": videos[0] if videos else None, "tags": list(tags),
                    **({"cover": images[0]} if images else {})}
        else:
            data = {"title": title, "content": text, "images": images, "videos": videos, "tags": list(tags)}
        handle = await self.open(info["injectUrl"])
        try:
            url = await self.wait_loaded(handle)
            await self.evaluate(handle, BUNDLE.read_text(encoding="utf-8") + "\n;true")
            await self.evaluate(handle, f"__opcMultiPost.run({json.dumps(key)}, {json.dumps(data, ensure_ascii=False)}, {json.dumps(files)})",
                                timeout=180)
        finally:
            await self.release(handle)
        return {"page_url": url or info["injectUrl"], "tab_id": handle.get("tab_id"), "platform_key": key}

    async def account(self, platform: str) -> dict[str, Any] | None:
        """The account logged in to this platform inside OpenWork's browser, or None."""
        page = ACCOUNT_PAGES.get(platform)
        if page is None:
            return None
        handle = await self.open(page)
        try:
            await self.wait_loaded(handle)
            await self.evaluate(handle, BUNDLE.read_text(encoding="utf-8") + "\n;true")
            info = await self.evaluate(handle, f"__opcMultiPost.account({json.dumps(platform)})", timeout=30)
        finally:
            await self.release(handle)
        if not isinstance(info, dict) or info.get("error") or not info.get("accountId"):
            return None
        extra = info.get("extraData") if isinstance(info.get("extraData"), dict) else {}
        return {"id": str(info["accountId"]), "name": info.get("username") or str(info["accountId"]),
                "handle": str(extra.get("handle") or extra.get("screen_name") or ""), "url": info.get("profileUrl") or ""}

    async def open_login(self, platform: str) -> dict[str, Any]:
        url = LOGIN_PAGES.get(platform)
        if url is None:
            raise OpenWorkError(f"{platform} 还没有登录入口")
        # Left open on purpose: the person logs in in the browser panel.
        handle = await self.open(url)
        handle["screenshot"] = await self.screenshot(handle)
        return handle

    async def screenshot(self, handle: dict[str, Any], settle_seconds: float = 2.5) -> str:
        """A PNG (base64) of the tab once it settles, e.g. a login QR code to show in the chat; empty if unavailable."""
        import websockets

        try:
            await self.wait_loaded(handle, seconds=15)
            await asyncio.sleep(settle_seconds)
            async with websockets.connect(await self._socket_url(handle), max_size=None) as socket:
                await socket.send(json.dumps({"id": 1, "method": "Page.captureScreenshot", "params": {"format": "png"}}))
                async with asyncio.timeout(15):
                    while True:
                        message = json.loads(await socket.recv())
                        if message.get("id") == 1:
                            return str(message.get("result", {}).get("data") or "")
        except (OpenWorkError, OSError, TimeoutError, ValueError, websockets.WebSocketException):
            return ""

    async def page_text(self, url: str, wait_seconds: float = 4) -> dict[str, Any]:
        handle = await self.open(url)
        try:
            await self.wait_loaded(handle)
            await asyncio.sleep(wait_seconds)
            text = await self.evaluate(handle, "(document.querySelector('main') || document.body).innerText") or ""
            final = await self.evaluate(handle, "location.href")
        finally:
            await self.release(handle)
        return {"url": final, "text": text[:20_000], "truncated": len(text) > 20_000}


def _paragraphs(text: str) -> str:
    import html

    return "".join(f"<p>{html.escape(block).replace(chr(10), '<br>')}</p>" for block in text.split("\n\n") if block.strip())
