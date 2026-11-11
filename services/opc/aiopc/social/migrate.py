"""Move the logins already in AIOPC's built-in browser into a project's environment.

Nobody should have to scan a QR code again because AIOPC changed where its
browser runs. The first time a project gets an environment, AIOPC copies the
logins across: cookies for every site, plus page storage for the few sites that
keep their token there instead. Passwords are never involved — only the proof
that the person already logged in, which the built-in browser was holding anyway.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import websockets

from .openwork import OpenWorkBrowser, OpenWorkError
from .sandbox_browser import SandboxBrowser

# Somewhere harmless to stand while reading the browser's cookies.
NEUTRAL = "https://example.com/"
# Sites whose login lives in page storage rather than a cookie.
STORAGE_ORIGINS = ("https://discord.com",)
COOKIE_FIELDS = ("name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "expires", "sourceScheme",
                 "sourcePort", "priority", "sameParty", "partitionKey")


async def _page_call(socket: Any, counter: list[int], method: str, params: dict[str, Any] | None = None,
                     timeout: float = 30) -> dict[str, Any]:
    counter[0] += 1
    await socket.send(json.dumps({"id": counter[0], "method": method, "params": params or {}}))
    async with asyncio.timeout(timeout):
        while True:
            message = json.loads(await socket.recv())
            if message.get("id") == counter[0]:
                break
    if "error" in message:
        raise OpenWorkError(str(message["error"].get("message")))
    return dict(message.get("result") or {})


async def _cookies(browser: OpenWorkBrowser) -> list[dict[str, Any]]:
    handle = await browser.open(NEUTRAL)
    try:
        async with websockets.connect(await browser._socket_url(handle), max_size=None) as socket:
            result = await _page_call(socket, [0], "Network.getAllCookies")
    finally:
        await browser.release(handle)
        await browser.close(handle)
    return list(result.get("cookies") or [])


async def _storage(browser: OpenWorkBrowser, origin: str) -> list[list[str]]:
    handle = await browser.open(origin + "/robots.txt")
    try:
        await browser.wait_loaded(handle, seconds=15)
        async with websockets.connect(await browser._socket_url(handle), max_size=None) as socket:
            counter = [0]
            await _page_call(socket, counter, "DOMStorage.enable")
            result = await _page_call(socket, counter, "DOMStorage.getDOMStorageItems",
                                      {"storageId": {"securityOrigin": origin, "isLocalStorage": True}})
        return [list(entry) for entry in (result.get("entries") or [])]
    except (OpenWorkError, OSError, TimeoutError, ValueError, websockets.WebSocketException):
        return []
    finally:
        await browser.release(handle)
        await browser.close(handle)


def _clean(cookie: dict[str, Any]) -> dict[str, Any]:
    kept = {key: value for key, value in cookie.items() if key in COOKIE_FIELDS}
    if kept.get("expires", -1) in (-1, 0):
        # A session cookie: keep it a session cookie rather than expiring it on arrival.
        kept.pop("expires", None)
    return kept


async def migrate_logins(source: OpenWorkBrowser, target: SandboxBrowser) -> dict[str, Any]:
    """Copy the built-in browser's logins into an environment. Returns what moved."""
    try:
        cookies = await _cookies(source)
    except (OpenWorkError, OSError, TimeoutError, ValueError, websockets.WebSocketException) as exc:
        return {"migrated": False, "cookies": 0, "origins": [], "message": f"没能读取内置浏览器的登录状态：{exc}"}
    moved = 0
    for cookie in cookies:
        try:
            await target._call("Storage.setCookies", {"cookies": [_clean(cookie)]})
            moved += 1
        except OpenWorkError:
            continue
    origins = []
    for origin in STORAGE_ORIGINS:
        entries = await _storage(source, origin)
        if not entries:
            continue
        handle = await target.open(origin + "/robots.txt")
        try:
            await target.wait_loaded(handle, seconds=20)
            async with websockets.connect(await target._socket_url(handle), max_size=None) as socket:
                counter = [0]
                await _page_call(socket, counter, "DOMStorage.enable")
                for key, value in entries:
                    await _page_call(socket, counter, "DOMStorage.setDOMStorageItem",
                                     {"storageId": {"securityOrigin": origin, "isLocalStorage": True},
                                      "key": key, "value": value})
            origins.append(origin)
        except (OpenWorkError, OSError, TimeoutError, ValueError, websockets.WebSocketException):
            pass
        finally:
            await target.close(handle)
    return {"migrated": moved > 0, "cookies": moved, "origins": origins,
            "message": f"已把内置浏览器的 {moved} 条登录信息搬进这个项目的环境。请打开账号页确认哪些还在登录。"}
