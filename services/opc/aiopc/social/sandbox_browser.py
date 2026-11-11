"""The browser inside a project's environment.

The environment is a computer of its own, so tabs are opened straight over
DevTools and the person watches its live picture when they want to. Everything
above this — filling a composer, checking who is logged in, reading a page —
lives in ``Browser`` and does not know where it runs.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from .browser import Browser, BrowserError


class SandboxBrowser(Browser):
    """The browser of one environment, reached over its DevTools address."""

    def __init__(self, endpoint: str):
        self.endpoint = endpoint.rstrip("/")

    # ── talking to the browser itself (not a page) ──────────────────────
    async def _browser_socket(self) -> str:
        if self.endpoint.startswith(("ws://", "wss://")):
            return self.endpoint
        try:
            async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
                response = await client.get(f"{self.endpoint}/json/version")
            return str(response.json()["webSocketDebuggerUrl"])
        except (httpx.HTTPError, ValueError, KeyError):
            raise BrowserError("连不上沙箱里的浏览器。请在项目设置里确认环境正在运行。") from None

    async def _call(self, method: str, params: dict[str, Any] | None = None, *, timeout: float = 30) -> dict[str, Any]:
        import websockets

        async with websockets.connect(await self._browser_socket(), max_size=None) as socket:
            await socket.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
            async with asyncio.timeout(timeout):
                while True:
                    message = json.loads(await socket.recv())
                    if message.get("id") == 1:
                        break
        if "error" in message:
            raise BrowserError(f"沙箱里的浏览器拒绝了操作：{message['error'].get('message')}")
        return dict(message.get("result") or {})

    # ── the four things every browser has to provide ────────────────────
    async def open(self, url: str) -> dict[str, Any]:
        target = (await self._call("Target.createTarget", {"url": url}))["targetId"]
        return {"provider": "sandbox", "browser_url": self.endpoint, "target_id": target, "tab_id": target, "url": url}

    async def close(self, handle: dict[str, Any]) -> None:
        try:
            await self._call("Target.closeTarget", {"targetId": handle.get("target_id")})
        except BrowserError:
            pass

    async def _socket_url(self, handle: dict[str, Any]) -> str:
        """A page's own DevTools address, so the inherited page work runs unchanged."""
        base = self.endpoint
        if not base.startswith(("ws://", "wss://")):
            try:
                async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
                    targets = (await client.get(f"{base}/json/list")).json()
            except (httpx.HTTPError, ValueError):
                raise BrowserError("连不上沙箱里的浏览器") from None
            target = next((item for item in targets if item.get("id") == handle.get("target_id")), None)
            if target is None:
                raise BrowserError("沙箱里的标签页已关闭")
            return str(target["webSocketDebuggerUrl"])
        # A cloud browser gives one address for the browser; a page is reached by swapping the path.
        root = base.split("/devtools/", 1)[0]
        query = base.split("?", 1)[1] if "?" in base else ""
        return f"{root}/devtools/page/{handle['target_id']}" + (f"?{query}" if query else "")

    # ── the person takes over in the live picture, not in a panel ───────
    async def open_login(self, platform: str, *, screenshot: bool = True) -> dict[str, Any]:
        from aiopc.platforms import LOGIN_PAGES

        url = LOGIN_PAGES.get(platform)
        if url is None:
            raise BrowserError(f"{platform} 还没有登录入口")
        handle = await self.open(url)
        await self._call("Target.activateTarget", {"targetId": handle["target_id"]})
        if screenshot:
            handle["screenshot"] = await self.screenshot(handle)
        return handle

    async def compose(self, platform: str, form: str, **kwargs: Any) -> dict[str, Any]:
        result = await super().compose(platform, form, **kwargs)
        if target := result.get("tab_id"):
            # Bring the filled composer to the front of the sandbox's screen so the person sees it.
            try:
                await self._call("Target.activateTarget", {"targetId": target})
            except BrowserError:
                pass
        return result
