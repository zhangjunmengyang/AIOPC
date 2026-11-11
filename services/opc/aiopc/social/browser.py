"""Working a web page: open a tab, inject MultiPost, read what is there.

This is everything AIOPC does with a browser, written against four small things
a browser has to provide (open a tab, close it, let it go, talk to it). The
project environment supplies those over DevTools. MultiPost (Apache-2.0) owns
the per-platform composer scripts; this module only runs them. Nothing is ever
published: the person reviews the filled composer and presses the button.
"""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
from pathlib import Path
from typing import Any

from aiopc.platforms import LOGIN_PAGES, MULTIPOST_KEYS

HERE = Path(__file__).resolve().parent
BUNDLE = HERE / "multipost" / "dist" / "multipost.js"
MAX_MEDIA_BYTES = 60 * 1024 * 1024

# Where each platform's "who is logged in" check runs (its own origin) and where to log in.
ACCOUNT_PAGES = {
    "x": "https://x.com/home", "xhs": "https://www.xiaohongshu.com/explore", "douyin": "https://creator.douyin.com",
    "bilibili": "https://t.bilibili.com", "tiktok": "https://www.tiktok.com", "zhihu": "https://www.zhihu.com",
}


# Detectors we maintain where MultiPost's no longer work: (page to run on, script returning MultiPost's shape).
OWN_DETECTORS: dict[str, tuple[str, str]] = {
    # The creator center's own API; MultiPost parsed the explore page's server state, which no longer carries the user.
    "xhs": ("https://creator.xiaohongshu.com/new/home", """(async () => {
      const response = await fetch("/api/galaxy/user/info", { credentials: "include" });
      if (!response.ok) return null;
      const body = await response.json();
      const user = body && body.data;
      if (!user || !user.userId) return null;
      return { accountId: user.userId, username: user.userName || "", profileUrl: "https://www.xiaohongshu.com/user/profile/" + user.userId,
               extraData: { handle: user.redId || "" } };
    })()"""),
    # The Official Accounts backend sends a logged-in visitor to its home page, which carries the account.
    "wechat": ("https://mp.weixin.qq.com/", """(() => {
      const data = window.wx && window.wx.data;
      if (!data || !data.uin || !location.href.includes("token=")) return null;
      return { accountId: String(data.uin), username: data.nick_name_decode || data.user_name || "",
               profileUrl: "", extraData: { handle: data.alias || data.user_name || "" } };
    })()"""),
    # Discord keeps its token in page storage (hidden from its own page; a fresh frame can still read it).
    "discord": ("https://discord.com/robots.txt", """(async () => {
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);
      const raw = frame.contentWindow.localStorage.getItem("token");
      frame.remove();
      if (!raw) return null;
      const response = await fetch("/api/v9/users/@me", { headers: { Authorization: JSON.parse(raw) } });
      if (!response.ok) return null;
      const user = await response.json();
      return { accountId: user.id, username: user.global_name || user.username, profileUrl: "",
               extraData: { handle: user.username } };
    })()"""),
}


class BrowserError(RuntimeError):
    pass


def multipost_key(platform: str, form: str) -> str:
    key = MULTIPOST_KEYS.get(platform, {}).get(form)
    if key is None:
        forms = "、".join(MULTIPOST_KEYS.get(platform, {})) or "无"
        raise BrowserError(f"{platform} 不支持“{form}”形式；可用：{forms}")
    return key


class Browser:
    """What AIOPC does with a page. A browser fills in the four methods below."""

    async def open(self, url: str) -> dict[str, Any]:
        """Open ``url`` in a new tab and return its handle."""
        raise NotImplementedError

    async def close(self, handle: dict[str, Any]) -> None:
        """Close a tab AIOPC opened only for its own work."""
        raise NotImplementedError

    async def release(self, handle: dict[str, Any]) -> None:
        """Hand the tab back to the person; not every browser has anything to do here."""
        return

    async def _socket_url(self, handle: dict[str, Any]) -> str:
        """The DevTools address of that tab."""
        raise NotImplementedError

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
            raise BrowserError("页面脚本出错：" + str((detail.get("exception") or {}).get("description") or detail.get("text"))[:500])
        return result.get("result", {}).get("value")

    async def wait_loaded(self, handle: dict[str, Any], seconds: float = 30) -> str:
        """Wait for the page the tab was opened for — a tab starts out empty, which is also "complete"."""
        for _ in range(int(seconds * 2)):
            state = await self.evaluate(handle, "document.readyState + '|' + location.href")
            if state and state.startswith("complete"):
                url = state.split("|", 1)[1]
                if not url.startswith(("about:", "chrome://")):
                    return url
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
                raise BrowserError("媒体总大小超过 60 MB；请压缩后再试")
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
        """The account logged in to this platform in the built-in browser, or None."""
        own = OWN_DETECTORS.get(platform)
        page = own[0] if own else ACCOUNT_PAGES.get(platform)
        if page is None:
            return None
        handle = await self.open(page)
        try:
            await self.wait_loaded(handle)
            if own:
                info = await self.evaluate(handle, own[1], timeout=30)
            else:
                await self.evaluate(handle, BUNDLE.read_text(encoding="utf-8") + "\n;true")
                info = await self.evaluate(handle, f"__opcMultiPost.account({json.dumps(platform)})", timeout=30)
        finally:
            await self.release(handle)
            await self.close(handle)
        if not isinstance(info, dict) or info.get("error") or not info.get("accountId"):
            return None
        extra = info.get("extraData") if isinstance(info.get("extraData"), dict) else {}
        return {"id": str(info["accountId"]), "name": info.get("username") or str(info["accountId"]),
                "handle": str(extra.get("handle") or extra.get("screen_name") or ""), "url": info.get("profileUrl") or ""}

    async def open_login(self, platform: str, *, screenshot: bool = True) -> dict[str, Any]:
        url = LOGIN_PAGES.get(platform)
        if url is None:
            raise BrowserError(f"{platform} 还没有登录入口")
        # Left open on purpose: the person logs in in the browser panel. Released right away so the
        # page is theirs: it follows the panel or full view instead of the agent's locked size.
        handle = await self.open(url)
        try:
            if screenshot:
                handle["screenshot"] = await self.screenshot(handle)
        finally:
            await self.release(handle)
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
        except (BrowserError, OSError, TimeoutError, ValueError, websockets.WebSocketException):
            return ""

    async def open_device_authorization(self, url: str, code: str) -> None:
        """Open GitHub's device page in the panel and type the one-time code; the person confirms on the page."""
        handle = await self.open(url)
        try:
            await self.wait_loaded(handle, seconds=20)
            await self.evaluate(handle, f"""(() => {{
              const code = {json.dumps(code.replace("-", ""))};
              const set = (input, value) => {{
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
                setter.call(input, value);
                input.dispatchEvent(new Event("input", {{ bubbles: true }}));
                input.dispatchEvent(new Event("change", {{ bubbles: true }}));
              }};
              const boxes = [...document.querySelectorAll("input[id^='user-code-']")];
              if (boxes.length >= code.length) {{ boxes.forEach((input, index) => set(input, code[index] || "")); return true; }}
              const single = document.querySelector("input[name='user-code'], input#user-code");
              if (single) {{ set(single, {json.dumps(code)}); return true; }}
              return false;
            }})()""", timeout=10)
        except BrowserError:
            pass
        finally:
            await self.release(handle)

    async def page_text(self, url: str, wait_seconds: float = 4) -> dict[str, Any]:
        handle = await self.open(url)
        try:
            await self.wait_loaded(handle)
            await asyncio.sleep(wait_seconds)
            text = await self.evaluate(handle, "(document.querySelector('main') || document.body).innerText") or ""
            final = await self.evaluate(handle, "location.href")
        finally:
            await self.release(handle)
            await self.close(handle)
        return {"url": final, "text": text[:20_000], "truncated": len(text) > 20_000}


def _paragraphs(text: str) -> str:
    import html

    return "".join(f"<p>{html.escape(block).replace(chr(10), '<br>')}</p>" for block in text.split("\n\n") if block.strip())
