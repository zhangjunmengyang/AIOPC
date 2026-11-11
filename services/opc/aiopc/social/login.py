"""Logging in by talking, instead of by operating a browser.

The person should not have to drive the project's computer. For most sites the
AI can do the whole login in the chat: it opens the page, cuts the QR code out
and shows just that, or asks for the phone number, types it, asks for the code
that arrived and types that too. Only sites that refuse to be automated at all
need the person to take over the picture.

These are deliberately generic: a field is found by the words next to it and a
button by the words on it, so a new platform needs no new code.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from .browser import Browser, BrowserError

# Many login pages put the real form in a frame of their own, so every script looks through those too.
FRAMES = """
  const __docs = () => {
    const found = [document];
    const walk = (doc) => {
      for (const frame of doc.querySelectorAll("iframe, frame")) {
        let inner = null;
        try { inner = frame.contentDocument; } catch (error) { inner = null; }
        if (inner && inner.body) { found.push(inner); walk(inner); }
      }
    };
    walk(document);
    return found;
  };
"""

# What a login page tends to call things, so the AI can ask for them by name.
READ_PAGE = """(() => {""" + FRAMES + """
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 2 && box.height > 2 && style.visibility !== "hidden" && style.display !== "none";
  };
  const label = (el) => {
    const described = el.labels && el.labels[0] && el.labels[0].innerText;
    return (described || el.placeholder || el.getAttribute("aria-label") || el.name || "").trim().slice(0, 60);
  };
  const all = (selector) => __docs().flatMap((doc) => [...doc.querySelectorAll(selector)]);
  const fields = all("input, textarea").filter(visible)
    .filter((el) => !["hidden", "submit", "button"].includes(el.type))
    .map((el) => ({ label: label(el), type: el.type || "text", value: el.value ? "(已填)" : "" }));
  // Login pages label their buttons with anything: a <button>, a link, a div with "btn" in its class.
  const buttons = all("button, a, [role=button], [role=tab], input[type=submit], [class*=btn i], [class*=button i]")
    .filter(visible).map((el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim())
    .filter((label) => label && label.length <= 20 && !label.includes(String.fromCharCode(10)));
  const text = __docs().map((doc) => ((doc.querySelector("main") || doc.body).innerText || "")).join(" ").replace(/\\s+/g, " ").trim().slice(0, 1200);
  return JSON.stringify({ url: location.href, title: document.title, fields, buttons: [...new Set(buttons)].slice(0, 25), text });
})()"""

# A QR code is a square image, canvas or SVG big enough to scan with a phone.
FIND_QR = """(() => {""" + FRAMES + """
  const offset = (doc) => {
    const frame = doc.defaultView && doc.defaultView.frameElement;
    if (!frame) return { x: 0, y: 0 };
    const box = frame.getBoundingClientRect();
    return { x: box.x, y: box.y };
  };
  const square = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width < 90 || box.height < 90) return null;
    if (Math.abs(box.width - box.height) > Math.max(box.width, box.height) * 0.25) return null;
    const shift = offset(el.ownerDocument);
    return { x: box.x + shift.x, y: box.y + shift.y, width: box.width, height: box.height };
  };
  const candidates = __docs().flatMap((doc) =>
    [...doc.querySelectorAll("canvas, img, svg, [class*=qr i], [class*=code i]")]);
  const scored = candidates.map((el) => ({ el, box: square(el) })).filter((item) => item.box)
    .map((item) => ({ ...item, score: (/qr|code|scan|扫码|二维码/i.test(item.el.className + " " + (item.el.alt || "")) ? 2 : 0)
                                       + item.box.width / 1000 }));
  scored.sort((a, b) => b.score - a.score);
  return scored.length ? JSON.stringify(scored[0].box) : "";
})()"""

FILL = """((label, value) => {""" + FRAMES + """
  const matches = (el) => {
    const described = (el.labels && el.labels[0] && el.labels[0].innerText) || "";
    const hay = [described, el.placeholder, el.getAttribute("aria-label"), el.name, el.id].join(" ").toLowerCase();
    return hay.includes(label.toLowerCase());
  };
  const fields = __docs().flatMap((doc) => [...doc.querySelectorAll("input, textarea")])
    .filter((el) => !["hidden", "submit", "button"].includes(el.type) && el.getBoundingClientRect().width > 2);
  const field = fields.find(matches) || (fields.length === 1 ? fields[0] : null);
  if (!field) return "没有找到这个输入框";
  const setter = Object.getOwnPropertyDescriptor(
    field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;
  field.focus();
  setter.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  return "";
})"""

CLICK = """((text) => {""" + FRAMES + """
  const wanted = text.trim().toLowerCase();
  const elements = __docs()
    .flatMap((doc) => [...doc.querySelectorAll("button, a, [role=button], [role=tab], input[type=submit], label, span, div")])
    .filter((el) => el.getBoundingClientRect().width > 2 && el.getBoundingClientRect().height > 2);
  const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
  const exact = elements.find((el) => label(el) === wanted);
  const partial = exact || elements.find((el) => label(el).includes(wanted) && label(el).length < wanted.length + 25);
  if (!partial) return "没有找到这个按钮";
  partial.click();
  return "";
})"""


class Login:
    """One conversational login, run in whichever browser the project uses."""

    def __init__(self, browser: Browser):
        self.browser = browser
        self._handle: dict[str, Any] | None = None

    # ── the page ────────────────────────────────────────────────────────
    async def open(self, url: str) -> dict[str, Any]:
        self._handle = await self.browser.open(url)
        await self.browser.wait_loaded(self._handle, seconds=25)
        return await self.settle()

    async def settle(self, seconds: float = 20) -> dict[str, Any]:
        """Login pages draw themselves after loading; wait until there is something to act on."""
        page: dict[str, Any] = {}
        deadline = asyncio.get_running_loop().time() + seconds
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(1)
            page = await self.read()
            if page.get("fields") or page.get("buttons"):
                return page
        return page or await self.read()

    def _tab(self) -> dict[str, Any]:
        if self._handle is None:
            raise BrowserError("还没有打开登录页")
        return self._handle

    async def read(self) -> dict[str, Any]:
        """What is on the page right now: the fields to fill and the buttons to press."""
        raw = await self.browser.evaluate(self._tab(), READ_PAGE, timeout=30)
        try:
            return json.loads(str(raw))
        except ValueError:
            return {"url": "", "title": "", "fields": [], "buttons": [], "text": ""}

    async def fill(self, label: str, value: str) -> None:
        problem = await self.browser.evaluate(self._tab(), f"({FILL})({json.dumps(label)}, {json.dumps(value)})", timeout=20)
        if problem:
            raise BrowserError(f"{problem}：{label}")

    async def click(self, text: str) -> None:
        problem = await self.browser.evaluate(self._tab(), f"({CLICK})({json.dumps(text)})", timeout=20)
        if problem:
            raise BrowserError(f"{problem}：{text}")
        await asyncio.sleep(1.5)

    # ── the QR code, cut out of the page ────────────────────────────────
    async def qr_code(self) -> str:
        """Just the QR code as a PNG (base64), so the chat shows something scannable."""
        import websockets

        handle = self._tab()
        box_json = await self.browser.evaluate(handle, FIND_QR, timeout=20)
        if not box_json:
            return ""
        box = json.loads(str(box_json))
        pad = 12
        clip = {"x": max(box["x"] - pad, 0), "y": max(box["y"] - pad, 0),
                "width": box["width"] + pad * 2, "height": box["height"] + pad * 2, "scale": 2}
        try:
            async with websockets.connect(await self.browser._socket_url(handle), max_size=None) as socket:
                await socket.send(json.dumps({"id": 1, "method": "Page.captureScreenshot",
                                              "params": {"format": "png", "clip": clip, "captureBeyondViewport": True}}))
                async with asyncio.timeout(20):
                    while True:
                        message = json.loads(await socket.recv())
                        if message.get("id") == 1:
                            return str(message.get("result", {}).get("data") or "")
        except (BrowserError, OSError, TimeoutError, ValueError, websockets.WebSocketException):
            return ""

    async def screenshot(self) -> str:
        return await self.browser.screenshot(self._tab(), settle_seconds=1)

    async def close(self) -> None:
        if self._handle is not None:
            await self.browser.close(self._handle)
            self._handle = None
