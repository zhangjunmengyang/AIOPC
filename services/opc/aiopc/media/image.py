"""Image generation and editing for chat tools, using the instance's media profile.

The profile (media-profiles.json → image) describes an OpenAI-compatible images
endpoint; credentials are ``${VAR}`` references resolved from the instance .env,
which the AIOPC service loads at start. Results land in the workspace's
assets/generated inside the workspace, where the desktop app can preview them.
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

SIZES = {"1024x1024", "1024x1536", "1536x1024", "auto"}
ASPECT_SIZES = {"1:1": "1024x1024", "3:4": "1024x1536", "2:3": "1024x1536", "4:3": "1536x1024", "3:2": "1536x1024",
                "9:16": "1024x1536", "16:9": "1536x1024"}
MAX_REFERENCES = 4


class ImageError(ValueError):
    pass


def _expand(value: Any) -> Any:
    if isinstance(value, str):
        return re.sub(r"\$\{([A-Z0-9_]+)\}", lambda match: os.environ.get(match[1], ""), value)
    if isinstance(value, dict):
        return {key: _expand(item) for key, item in value.items()}
    return value


class ImageService:
    def __init__(self, instance: Path, workspace: Path, client: httpx.AsyncClient | None = None,
                 reference_resolver: Callable[[str], Path] | None = None):
        self.instance = Path(instance)
        self.workspace = Path(workspace)
        self.client = client
        self.reference_resolver = reference_resolver

    def _profile(self) -> dict[str, Any]:
        path = self.instance / "media-profiles.json"
        try:
            profile = json.loads(path.read_text(encoding="utf-8"))["image"]
        except (OSError, ValueError, KeyError):
            raise ImageError("没有配置生图服务（media-profiles.json 缺少 image）") from None
        profile = _expand(profile)
        if not (profile.get("baseUrl") and profile.get("model") and profile.get("authorization", "").strip() not in {"", "Bearer"}):
            raise ImageError("生图服务的地址、模型或密钥为空；检查实例 .env")
        return profile

    def _reference(self, item: str) -> Path:
        path = Path(item).expanduser()
        path = (self.workspace / path).resolve() if not path.is_absolute() else path.resolve()
        roots = [self.workspace.resolve(), (self.instance / "media").resolve()]
        if not any(path.is_relative_to(root) for root in roots) or not path.is_file():
            if self.reference_resolver:
                try:
                    return self.reference_resolver(str(path))
                except ValueError:
                    pass
            raise ImageError(f"参考图需在工作区或已生成的媒体目录中：{item}")
        return path

    async def generate(self, prompt: str, aspect_ratio: str = "1:1", reference_images: list[str] | None = None,
                       count: int = 1) -> dict[str, Any]:
        """Generate (or, with reference images, edit) images; returns local file paths."""
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8000:
            raise ImageError("prompt 不能为空，且不超过 8000 字")
        size = ASPECT_SIZES.get(aspect_ratio, aspect_ratio)
        if size not in SIZES:
            raise ImageError(f"aspect_ratio 取 {'、'.join(ASPECT_SIZES)}")
        if not isinstance(count, int) or not 1 <= count <= 4:
            raise ImageError("count 取 1–4")
        references = [self._reference(item) for item in (reference_images or [])][:MAX_REFERENCES]
        profile = self._profile()
        defaults = {**profile.get("defaults", {}), "n": count, "size": size}
        headers = {"Authorization": profile["authorization"]}
        base = profile["baseUrl"].rstrip("/")
        client = self.client or httpx.AsyncClient(timeout=300, trust_env=False)
        try:
            if references:
                edit = profile.get("edit", {})
                field = edit.get("imageField", "image")
                files = [(field if len(references) == 1 else f"{field}[]", (path.name, path.read_bytes())) for path in references]
                data = {key: str(value) for key, value in {**defaults, "model": profile["model"], "prompt": prompt}.items()}
                response = await client.post(base + edit.get("path", "/images/edits"), headers=headers, data=data, files=files)
            else:
                generate = profile.get("generate", {})
                response = await client.post(base + generate.get("path", "/images/generations"), headers=headers,
                                             json={**defaults, "model": profile["model"], "prompt": prompt})
        except httpx.HTTPError as exc:
            raise ImageError(f"生图服务暂时无法访问（{type(exc).__name__}）") from None
        finally:
            if self.client is None:
                await client.aclose()
        if response.status_code >= 400:
            raise ImageError(f"生图服务返回 HTTP {response.status_code}：{response.text[:300]}")
        items = (response.json() or {}).get("data") or []
        suffix = "." + str(defaults.get("output_format", "png")).replace("jpeg", "jpg")
        # The workspace is the project: its images go into its own assets.
        folder = self.workspace / "assets" / "generated" / time.strftime("%Y-%m-%d")
        folder.mkdir(parents=True, exist_ok=True)
        paths = []
        for item in items:
            if item.get("b64_json"):
                raw = base64.b64decode(item["b64_json"])
            elif item.get("url"):
                async with httpx.AsyncClient(timeout=120, trust_env=False) as download:
                    raw = (await download.get(item["url"])).content
            else:
                continue
            path = folder / f"img_{uuid.uuid4().hex[:12]}{suffix}"
            path.write_bytes(raw)
            paths.append(path)
        if not paths:
            raise ImageError("生图服务没有返回图片")
        return {"images": [str(path) for path in paths], "size": size,
                "edited_from": [str(path) for path in references]}
