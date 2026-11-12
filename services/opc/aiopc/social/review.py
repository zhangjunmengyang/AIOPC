"""Frozen publishing previews; only an approved MCP App action can fill the website."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

from filelock import FileLock

from .service import DETECTED, SocialError, SocialService

RESOURCE = "ui://aiopc/publish-review"
MAX_AGE = 24 * 60 * 60


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def file_digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class PublishReview:
    def __init__(self, social: SocialService):
        self.social = social
        scope = hashlib.sha256(str(social.workspace.resolve()).encode()).hexdigest()[:24]
        self.root = social.instance / "publish-reviews" / scope
        self.root.mkdir(parents=True, exist_ok=True)

    def prepare(self, account_id: str, text: str, title: str = "", media: list[str] | None = None,
                form: str = "post", tags: list[str] | None = None) -> dict:
        checked = self.social.check_publish(account_id, text, title, media, form, tags)
        account, info, post = checked["account"], checked["info"], checked["post"]
        if str(account.get("project") or "") != str(self.social.workspace):
            raise SocialError("这个账号不属于当前项目环境，请先在当前项目登录")
        binding = self.social.binding(account=account)
        payload = {"account_id": account_id, "text": post.text, "title": post.title,
                   "media": [str(path) for path in post.media], "form": post.form, "tags": post.tags}
        review_id = secrets.token_hex(16)
        media_root = self._media_root(review_id)
        media_root.mkdir(parents=True, mode=0o700, exist_ok=True)
        hashes = {}
        for index, path in enumerate(post.media):
            frozen = media_root / f"{index:02d}{path.suffix.lower()}"
            shutil.copyfile(path, frozen)
            frozen.chmod(0o600)
            hashes[str(path)] = file_digest(frozen)
        preview = {"payload": payload, "identity_id": str((account.get("identity") or {}).get("id") or ""),
                   "platform_id": account["platform"], "account": info["name"], "platform": info["platform_name"],
                   "media_hashes": hashes, "environment": binding["id"] if binding else account.get("environment"),
                   "bindingRevision": binding["bindingRevision"] if binding else None}
        review = {"id": review_id, "digest": digest(preview), "created_at": time.time(),
                  "status": "awaiting_approval", **preview}
        self._save(review)
        return {**review, "message": "请在稿件卡片中确认后填写发布页。最终发布由你点击。"}

    def preview_media(self, review: dict) -> list[dict]:
        from PIL import Image, ImageOps, UnidentifiedImageError

        media = []
        for index, filename in enumerate(review["payload"]["media"]):
            path = self._media_root(review["id"]) / f"{index:02d}{Path(filename).suffix.lower()}"
            item = {"name": Path(filename).name}
            try:
                with Image.open(path) as original:
                    image = ImageOps.exif_transpose(original)
                    image.thumbnail((240, 240))
                    buffer = io.BytesIO()
                    image.convert("RGB").save(buffer, "JPEG", quality=55)
                    item["preview"] = "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()
            except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
                pass
            media.append(item)
        return media

    def _media_root(self, review_id: str) -> Path:
        self._path(review_id)  # Validate the id before using it in a path.
        return self.social.instance / "media" / "publish-reviews" / self.root.name / review_id

    def _path(self, review_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{32}", review_id):
            raise SocialError("稿件编号无效")
        return self.root / f"{review_id}.json"

    def _save(self, review: dict) -> None:
        target = self._path(review["id"])
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(review, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.chmod(0o600)
        temporary.replace(target)

    async def decide(self, review_id: str, revision: str, decision: str, *, app_action: dict | None = None) -> dict:
        if not app_action or app_action.get("approved") is not True or app_action.get("resourceUri") != RESOURCE:
            raise SocialError("请由用户在对话中的稿件卡片上确认，AI 不能代为审批")
        path = self._path(review_id)
        with FileLock(str(path) + ".lock"):
            if not path.is_file():
                raise SocialError("稿件不存在，请重新生成审批卡片")
            review = json.loads(path.read_text(encoding="utf-8"))
            frozen = {key: review.get(key) for key in ("payload", "account", "platform", "platform_id", "identity_id", "media_hashes", "environment", "bindingRevision")}
            if revision != review["digest"] or revision != digest(frozen):
                raise SocialError("稿件已变更，请重新确认")
            if review["status"] == "composer_filled":
                return review["result"]
            if review["status"] != "awaiting_approval":
                raise SocialError("这份稿件已处理，请重新生成审批卡片")
            if time.time() - review["created_at"] > MAX_AGE:
                raise SocialError("稿件审批已过期，请重新确认")
            if decision not in ("approve", "reject"):
                raise SocialError("审批操作无效")
            if decision == "reject":
                review["status"] = "rejected"
                self._save(review)
                return {"status": "rejected", "message": "已退回修改，发布页未填写。"}
            frozen_media = []
            for index, (filename, expected) in enumerate(review["media_hashes"].items()):
                media = self.social._media([filename])[0]
                if file_digest(media) != expected:
                    raise SocialError("媒体文件已变更，请重新生成审批卡片")
                frozen = self._media_root(review_id) / f"{index:02d}{media.suffix.lower()}"
                if not frozen.is_file() or frozen.is_symlink() or file_digest(frozen) != expected:
                    raise SocialError("审批媒体副本已变更，请重新生成审批卡片")
                frozen_media.append(str(frozen))
            account = self.social._account(review["payload"]["account_id"])
            if str(account.get("project") or "") != str(self.social.workspace):
                raise SocialError("账号已更换项目环境，请重新确认")
            binding = self.social.binding(account=account)
            if binding and (binding["id"] != review.get("environment") or binding["bindingRevision"] != review.get("bindingRevision")):
                raise SocialError("账号环境或绑定已经变更，请重新生成审批卡片")
            review["status"] = "filling"
            self._save(review)
        try:
            if account["platform"] != review["platform_id"] or str((account.get("identity") or {}).get("id") or "") != review["identity_id"]:
                raise SocialError("目标账号已变更，请重新确认")
            browser = await self.social.browser_for(account)
            async with self.social._browser_operation(browser):
                current = self.social.binding(account=account)
                if current and (current["id"] != review.get("environment") or current["bindingRevision"] != review.get("bindingRevision")):
                    raise SocialError("账号环境或绑定已经变更，请重新生成审批卡片")
                if account["platform"] in DETECTED:
                    identity = await browser.account(account["platform"])
                    if not identity or str(identity.get("id") or "") != review["identity_id"]:
                        self.social.store.mark_checked(account["id"], False)
                        raise SocialError("项目环境当前登录的账号与审批稿件不一致，请重新登录并确认")
                result = await self.social.publish(**{**review["payload"], "media": frozen_media})
        except Exception:
            review["status"] = "failed"
            self._save(review)
            raise
        review.update(status="composer_filled", result=result)
        self._save(review)
        return result
