"""Durable Seedance tasks through the user-configured MaaS gateway.

The gateway URL is trusted configuration, never a model-supplied URL. Generated
media URLs are untrusted: only public https addresses are fetched, without gateway credentials.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import math
import os
import re
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, NotRequired, TypedDict, cast
from urllib.parse import quote, urljoin, urlsplit

import httpx
from filelock import FileLock
from filelock import Timeout as FileLockTimeout

from aiopc.paths import inside, public_https_url

TERMINAL = {"succeeded", "failed", "cancelled", "expired"}
REMOTE_STATUSES = TERMINAL | {"queued", "running"}
JOB_ID = re.compile(r"vid_[a-f0-9]{24}\Z")
LEGACY_JOB_ARCHIVE = "legacy-jobs"
# MaaS prefixes Ark IDs with the routed model (e.g. Model-2.5:cgt-...).
# Keep that opaque ID intact, but reject path/query separators and URL escapes.
REMOTE_ID = re.compile(r"[A-Za-z0-9_.:-]{1,200}\Z")
OPTION_KEYS = {
    "duration", "resolution", "ratio", "seed", "generate_audio", "watermark",
    "return_last_frame", "camera_fixed", "draft", "output_format",
}

_PRIVATE_DOWNLOAD_LOGS: ContextVar[bool] = ContextVar("opc_private_download_logs", default=False)


class _DownloadHTTPLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # HTTPX's routine request log contains the full signed download URL.
        # A permanent, task-local filter leaves concurrent requests and all
        # warnings/errors visible without changing the logger's global level.
        return record.levelno >= logging.WARNING or not _PRIVATE_DOWNLOAD_LOGS.get()


logging.getLogger("httpx").addFilter(_DownloadHTTPLogFilter())


@asynccontextmanager
async def _private_download_logs() -> AsyncIterator[None]:
    token = _PRIVATE_DOWNLOAD_LOGS.set(True)
    try:
        yield
    finally:
        _PRIVATE_DOWNLOAD_LOGS.reset(token)


class VideoJob(TypedDict):
    id: str
    status: str
    model: str
    workspace: NotRequired[str]
    created_at: float
    updated_at: NotRequired[float]
    prompt: NotRequired[str]
    first_frame: NotRequired[str | None]
    options: NotRequired[dict[str, Any]]
    fingerprint: NotRequired[str]
    task_id: NotRequired[str]
    video_url: NotRequired[str]
    path: NotRequired[str]
    mime: NotRequired[str]
    bytes: NotRequired[int]
    error: NotRequired[str]
    last_error: NotRequired[str]
    query_retryable: NotRequired[bool]
    usage: NotRequired[dict[str, int]]
    submission_response: NotRequired[dict[str, Any]]


class MediaError(RuntimeError):
    """Safe-to-display media failure; contains no authorization or signed URL."""

    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class VideoConfig:
    tasks_url: str
    api_key: str = field(repr=False)
    model: str
    request_timeout_s: float = 45
    download_timeout_s: float = 120
    max_download_bytes: int = 512 * 1024 * 1024

    def __post_init__(self) -> None:
        parsed = urlsplit(self.tasks_url)
        if (
            parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment
            or not parsed.path.rstrip("/").endswith("/contents/generations/tasks")
        ):
            raise ValueError("Configure an HTTPS contents/generations/tasks endpoint without query credentials.")
        if not self.api_key or not self.model:
            raise ValueError("Video API key and model must be configured.")

    @classmethod
    def from_env(cls) -> VideoConfig:
        return cls(
            tasks_url=os.environ.get("MAAS_VIDEO_TASKS_URL", "").rstrip("/"),
            api_key=os.environ.get("MAAS_VIDEO_API_KEY", ""),
            model=os.environ.get("MAAS_VIDEO_MODEL", ""),
        )


class MediaScopeError(MediaError):
    """A job exists, but it belongs to another project."""


class VideoService:
    """Shared instance jobs; on restart resume by local job ID.

    Network creation is never automatically retried. A caller-supplied request_id
    deduplicates retries, including after process restart. Job files are private
    because they contain prompts and expiring provider download URLs.
    """

    def __init__(
        self,
        instance_dir: str | Path,
        *,
        workspace: str | Path | None = None,
        config: VideoConfig | None = None,
        client: httpx.AsyncClient | None = None,
        download_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.instance = Path(instance_dir).expanduser().resolve()
        self.workspace = Path(workspace or self.instance / "workspace").expanduser().resolve()
        self.config = config or VideoConfig.from_env()
        self.root = self.instance / "media" / "video"
        self.jobs = self.root / "jobs"
        self.files = self.root / "files"
        for directory in (self.root, self.jobs, self.files):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            directory.chmod(0o700)
        self._client = client
        self._download_transport = download_transport

    @asynccontextmanager
    async def _job_lock(self, job_id: str):
        # A separate CLI/MCP process may own the same task. Acquire without
        # blocking the event loop, and retain the lock through network+commit.
        lock_path = self._path(job_id).with_suffix(".lock")
        lock = FileLock(lock_path, timeout=0, thread_local=False, mode=0o600)
        while True:
            try:
                lock.acquire(timeout=0)
                break
            except FileLockTimeout:
                await asyncio.sleep(0.05)
        try:
            yield
        finally:
            lock.release()

    def _safe(self, value: object) -> str:
        text = str(value).replace(self.config.api_key, "[redacted]")
        text = re.sub(r"https?://[^\s\"'<>]+", "[provider URL]", text)
        text = re.sub(r"(?i)(?:bearer\s+|api[-_]?key[=: ]+)[^\s,;]+", "[redacted]", text)
        return text[:500]

    def _path(self, job_id: str) -> Path:
        if not JOB_ID.fullmatch(job_id):
            raise ValueError("Use a local video job ID returned by create().")
        return self.jobs / f"{job_id}.json"

    def _read(self, job_id: str) -> VideoJob:
        try:
            record = json.loads(self._path(job_id).read_text())
        except FileNotFoundError as exc:
            raise MediaError("Video job not found.") from exc
        if not isinstance(record, dict) or record.get("id") != job_id or not isinstance(record.get("status"), str) or not isinstance(record.get("model"), str) or not isinstance(record.get("created_at"), (float, int)):
            raise MediaError("Video job record is invalid; it has not been overwritten.")
        owner = record.get("workspace")
        legacy_default = (self.instance / "workspace").resolve()
        if owner != str(self.workspace) and not (owner is None and self.workspace == legacy_default):
            raise MediaScopeError("Video job does not belong to this project.")
        for key in ("task_id", "video_url", "path", "mime", "error", "last_error", "fingerprint"):
            if key in record and not isinstance(record[key], str):
                raise MediaError("Video job metadata is invalid; it has not been overwritten.")
        return cast(VideoJob, record)

    def _save(self, record: VideoJob, *, exclusive: bool = False) -> bool:
        path = self._path(record["id"])
        record["updated_at"] = time.time()
        record.setdefault("workspace", str(self.workspace))
        data = json.dumps(record, ensure_ascii=False, indent=2).encode()
        # Every write is under the per-job cross-process lock. Initial records
        # also use atomic rename, so read-only list/get never see a partial JSON.
        if exclusive and path.exists():
            return False
        temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        return True

    @staticmethod
    def _public(record: VideoJob) -> dict[str, Any]:
        keys = (
            "id", "task_id", "status", "model", "created_at", "updated_at",
            "path", "mime", "bytes", "error", "last_error", "query_retryable", "usage",
        )
        result = {key: record[key] for key in keys if key in record}
        has_file = bool(record.get("path")) and Path(record["path"]).is_file()
        if not has_file:
            for key in ("path", "mime", "bytes"):
                result.pop(key, None)
        result["can_resume"] = bool(record.get("task_id")) and not has_file and record["status"] not in {"failed", "cancelled", "expired"}
        result["can_cancel"] = record["status"] == "queued"
        if record["status"] in {"submitting", "submission_unknown"}:
            result["next_step"] = "Submission outcome is unknown. Do not resubmit automatically; recover the provider task ID first."
        elif has_file:
            result["next_step"] = "Deliver the local path with the message tool media parameter."
        elif result["can_resume"]:
            result["next_step"] = "Call wait() with the same local job ID; do not create another task."
        return result

    def get(self, job_id: str) -> dict[str, Any]:
        return self._public(self._read(job_id))

    def has_job(self, job_id: str) -> bool:
        try:
            self._read(job_id)
            return True
        except MediaError:
            return False

    def safe_error(self, error: object) -> str:
        return self._safe(error)

    def list_jobs(self, limit: int = 20) -> list[dict[str, Any]]:
        if not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100.")
        records = []
        for path in self.jobs.glob("vid_*.json"):
            try:
                records.append(self._read(path.stem))
            except MediaScopeError:
                continue
        records.sort(key=lambda record: record["created_at"], reverse=True)
        return [self._public(record) for record in records[:limit]]

    async def _request(self, method: str, *, task_id: str | None = None, body: dict[str, Any] | None = None) -> dict[str, Any]:
        url = self.config.tasks_url.rstrip("/")
        if task_id:
            if not REMOTE_ID.fullmatch(task_id):
                raise MediaError("Provider returned an invalid task ID.")
            url += "/" + quote(task_id, safe="")
        headers = {"api-key": self.config.api_key, "Content-Type": "application/json"}
        # This MaaS gateway routes every request by JSON body.model, including
        # GET/DELETE. Query parameters or a model header do not route the key.
        if body is None and method in {"GET", "DELETE"}:
            body = {"model": self.config.model}
        try:
            if self._client is not None:
                response = await self._client.request(method, url, json=body, headers=headers, follow_redirects=False, timeout=self.config.request_timeout_s)
            else:
                async with httpx.AsyncClient(timeout=self.config.request_timeout_s, trust_env=False) as client:
                    response = await client.request(method, url, json=body, headers=headers, follow_redirects=False)
        except httpx.RequestError as exc:
            raise MediaError(f"Video gateway connection failed ({type(exc).__name__}); no automatic resubmission.", retryable=True) from None
        if response.status_code >= 300:
            code = ""
            try:
                payload = response.json()
                error = payload.get("error", payload) if isinstance(payload, dict) else {}
                if isinstance(error, dict):
                    # MaaS returns RFC7807-style detail/title; Ark uses error.message.
                    code = self._safe(error.get("message") or error.get("detail") or error.get("title") or error.get("code") or "")
            except ValueError:
                pass
            raise MediaError(f"Video gateway HTTP {response.status_code}" + (f": {code}" if code else ""), retryable=response.status_code >= 500 or response.status_code == 429)
        if response.status_code == 204 or not response.content:
            return {}
        try:
            payload = response.json()
        except ValueError:
            raise MediaError("Video gateway returned invalid JSON.", retryable=method == "POST") from None
        if not isinstance(payload, dict):
            raise MediaError("Video gateway returned a non-object response.", retryable=method == "POST")
        return payload

    def _first_frame(self, path: str) -> str:
        target = inside(path, self.workspace, [self.workspace, self.instance / "media"])
        if target is None or not target.is_file() or target.stat().st_size > 20 * 1024 * 1024:
            raise ValueError("First frame must be an existing image (at most 20 MiB) inside the workspace.")
        head = target.read_bytes()[:12]
        mime = ("image/png" if head.startswith(b"\x89PNG") else "image/jpeg" if head.startswith(b"\xff\xd8")
                else "image/webp" if head[8:12] == b"WEBP" else "image/gif" if head[:4] == b"GIF8" else None)
        if mime is None:
            raise ValueError("First frame must contain a supported PNG, JPEG, WEBP, or GIF image.")
        return f"data:{mime};base64," + base64.b64encode(target.read_bytes()).decode()

    async def create(self, prompt: str, *, first_frame: str | None = None, options: dict[str, Any] | None = None, request_id: str | None = None) -> dict[str, Any]:
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 20000:
            raise ValueError("Provide a nonempty video prompt of at most 20000 characters.")
        options = dict(options or {})
        if unknown := options.keys() - OPTION_KEYS:
            raise ValueError("Unsupported video options: " + ", ".join(sorted(unknown)))
        if any(not isinstance(value, (str, int, float, bool)) or isinstance(value, float) and not math.isfinite(value) for value in options.values()):
            raise ValueError("Video options must be finite scalar values.")
        if request_id is not None and (not request_id.strip() or len(request_id) > 200):
            raise ValueError("request_id must contain 1–200 characters.")
        fingerprint = hashlib.sha256(json.dumps([prompt, first_frame, options, self.config.model], sort_keys=True).encode()).hexdigest()
        identifier = hashlib.sha256(f"{self.workspace}\x00{request_id}".encode()).hexdigest()[:24] if request_id else uuid.uuid4().hex[:24]
        job_id = "vid_" + identifier
        async with self._job_lock(job_id):
            previous = self._read(job_id) if self._path(job_id).exists() else None
            if previous is None and request_id is not None:
                # Older jobs derived their ID from the request alone. The archive
                # marks migrated records, and _read still requires the current project.
                legacy_id = "vid_" + hashlib.sha256(request_id.encode()).hexdigest()[:24]
                archive = self.root / LEGACY_JOB_ARCHIVE / f"{legacy_id}.json"
                if legacy_id != job_id and archive.is_file() and self._path(legacy_id).is_file():
                    async with self._job_lock(legacy_id):
                        try:
                            previous = self._read(legacy_id)
                        except MediaScopeError:
                            pass
            if previous is not None:
                if previous.get("fingerprint") != fingerprint:
                    raise ValueError("request_id was already used for a different video request.")
                return self._public(previous)
            content: list[dict[str, Any]] = [{"type": "text", "text": prompt.strip()}]
            if first_frame:
                content.append({"type": "image_url", "image_url": {"url": self._first_frame(first_frame)}, "role": "first_frame"})
                options.setdefault("ratio", "adaptive")
            body = {"model": self.config.model, "content": content, **options}
            record: VideoJob = {"id": job_id, "model": self.config.model, "prompt": prompt, "first_frame": first_frame, "options": options, "fingerprint": fingerprint, "status": "submitting", "created_at": time.time()}
            if not self._save(record, exclusive=True):
                previous = self._read(job_id)
                if previous.get("fingerprint") != fingerprint:
                    raise ValueError("request_id was already used for a different video request.")
                return self._public(previous)
            try:
                result = await self._request("POST", body=body)
                record["submission_response"] = result
                task_id = result.get("id")
                if not isinstance(task_id, str) or not REMOTE_ID.fullmatch(task_id):
                    raise MediaError("Task submission returned no valid task ID; outcome unknown.", retryable=True)
                record.update(task_id=task_id, status="queued")
            except asyncio.CancelledError:
                record.update(status="submission_unknown", error="Request interrupted; check provider task history before retrying.")
                self._save(record)
                raise
            except MediaError as exc:
                record.update(status="submission_unknown" if exc.retryable else "failed", error=str(exc))
            self._save(record)
            return self._public(record)

    def _apply_status(self, record: VideoJob, payload: dict[str, Any]) -> None:
        status = payload.get("status")
        if not isinstance(status, str) or status not in REMOTE_STATUSES:
            raise MediaError("Video gateway returned an unrecognized task status.")
        record["status"] = status
        record.pop("last_error", None)
        record.pop("query_retryable", None)
        content = payload.get("content")
        if isinstance(content, dict) and isinstance(content.get("video_url"), str):
            record["video_url"] = content["video_url"]
        if status == "failed":
            error = payload.get("error")
            record["error"] = self._safe(error.get("message") or error.get("code")) if isinstance(error, dict) else "Video generation failed."
        usage = payload.get("usage")
        if isinstance(usage, dict):
            record["usage"] = {key: value for key, value in usage.items() if key in {"completion_tokens", "total_tokens"} and isinstance(value, int)}

    def _check_response_id(self, payload: dict[str, Any], task_id: str) -> None:
        expected = {task_id}
        prefix = self.config.model + ":"
        if task_id.startswith(prefix):
            expected.add(task_id[len(prefix):])
        # MaaS creation adds Model: while query returns Ark's unprefixed ID.
        if payload.get("id") is not None and (not isinstance(payload["id"], str) or payload["id"] not in expected):
            raise MediaError("Provider returned a different task ID; response was not applied.")

    async def status(self, job_id: str) -> dict[str, Any]:
        async with self._job_lock(job_id):
            record = self._read(job_id)
            if not record.get("task_id") or self._public(record).get("path") or record["status"] in {"failed", "cancelled", "expired"}:
                return self._public(record)
            for key in ("path", "mime", "bytes"):
                record.pop(key, None)
            try:
                payload = await self._request("GET", task_id=record["task_id"])
                self._check_response_id(payload, record["task_id"])
                self._apply_status(record, payload)
            except MediaError as exc:
                record["last_error"] = str(exc)
                record["query_retryable"] = exc.retryable
            self._save(record)
            return self._public(record)

    async def recover(self, job_id: str, task_id: str) -> dict[str, Any]:
        """Associate a provider ID obtained by the user after unknown submission."""
        async with self._job_lock(job_id):
            record = self._read(job_id)
            if record.get("task_id") and record["task_id"] != task_id:
                raise ValueError("This job already belongs to a different provider task.")
            payload = await self._request("GET", task_id=task_id)
            self._check_response_id(payload, task_id)
            self._apply_status(record, payload)
            record["task_id"] = task_id
            if record["status"] != "failed":
                record.pop("error", None)
            self._save(record)
            return self._public(record)

    async def wait(self, job_id: str, timeout_s: float = 60, poll_interval_s: float = 5, download: bool = True) -> dict[str, Any]:
        if not math.isfinite(timeout_s) or not 0 <= timeout_s <= 120 or not math.isfinite(poll_interval_s) or not 1 <= poll_interval_s <= 30:
            raise ValueError("Use timeout_s 0–120 and poll_interval_s 1–30.")
        deadline = time.monotonic() + timeout_s
        result = self.get(job_id)
        for _ in range(min(120, math.ceil(timeout_s / poll_interval_s) + 1)):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not result.get("can_resume"):
                break
            try:
                result = await asyncio.wait_for(self.status(job_id), timeout=remaining)
            except TimeoutError:
                break
            if result["status"] in TERMINAL:
                break
            if result.get("last_error") and not result.get("query_retryable"):
                break
            await asyncio.sleep(min(poll_interval_s, max(0, deadline - time.monotonic())))
        if download and result["status"] == "succeeded" and not result.get("path"):
            return await self.download(job_id)
        result["waiting"] = result["status"] not in TERMINAL and bool(result.get("task_id"))
        return result

    async def download(self, job_id: str) -> dict[str, Any]:
        async with self._job_lock(job_id):
            record = self._read(job_id)
            if record.get("path") and Path(record["path"]).is_file():
                return self._public(record)
            if record["status"] != "succeeded" or not record.get("video_url"):
                raise MediaError("Query the job until it succeeds and supplies a video URL before downloading.")
            temporary = self.files / f".{job_id}.{uuid.uuid4().hex}.part"
            try:
                size, mime = await asyncio.wait_for(self._download(record["video_url"], temporary), timeout=self.config.download_timeout_s)
                suffix = ".mov" if mime == "video/quicktime" else ".mp4"
                path = self.files / f"{job_id}{suffix}"
                os.replace(temporary, path)
                record.update(path=str(path), mime=mime, bytes=size)
                record.pop("last_error", None)
            except (MediaError, httpx.RequestError, TimeoutError, OSError) as exc:
                record["last_error"] = self._safe(exc) if isinstance(exc, MediaError) else f"Video download failed ({type(exc).__name__}); call download() to retry."
            finally:
                temporary.unlink(missing_ok=True)
            self._save(record)
            return self._public(record)

    @_private_download_logs()
    async def _download(self, url: str, target: Path) -> tuple[int, str]:
        async with httpx.AsyncClient(transport=self._download_transport, timeout=self.config.download_timeout_s, trust_env=False, follow_redirects=False) as client:
            for _ in range(6):
                if not public_https_url(url):
                    raise MediaError("Video download URL must be a public https address.")
                # Never send gateway authorization to media/CDN hosts.
                async with client.stream("GET", url) as response:
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise MediaError("Video download redirect lacked a destination.")
                        url = urljoin(str(response.url), location)
                        continue
                    if response.status_code != 200:
                        raise MediaError(f"Video download HTTP {response.status_code}; refresh task status before retrying.")
                    length = response.headers.get("content-length", "")
                    if length.isdecimal() and int(length) > self.config.max_download_bytes:
                        raise MediaError("Video exceeds the configured download size limit.")
                    count, prefix = 0, b""
                    with target.open("xb") as stream:
                        target.chmod(0o600)
                        async for chunk in response.aiter_bytes():
                            count += len(chunk)
                            if count > self.config.max_download_bytes:
                                raise MediaError("Video exceeds the configured download size limit.")
                            if len(prefix) < 32:
                                prefix += chunk[:32 - len(prefix)]
                            stream.write(chunk)
                        stream.flush()
                        os.fsync(stream.fileno())
                    if len(prefix) < 12 or prefix[4:8] != b"ftyp":
                        raise MediaError("Downloaded response is not an MP4/MOV video.")
                    mime = "video/quicktime" if prefix[8:12] == b"qt  " else "video/mp4"
                    return count, mime
        raise MediaError("Video download exceeded the redirect limit.")

    async def cancel(self, job_id: str) -> dict[str, Any]:
        result = await self.status(job_id)
        if result["status"] != "queued" or result.get("last_error"):
            result["cancelled"] = result["status"] == "cancelled"
            result["cancel_note"] = "Only confirmed queued tasks can be cancelled. Running tasks cannot be cancelled; completed records are not deleted."
            return result
        async with self._job_lock(job_id):
            record = self._read(job_id)
            if record["status"] != "queued":
                return self._public(record)
            try:
                await self._request("DELETE", task_id=record["task_id"])
                record["status"] = "cancelled"
                record.pop("last_error", None)
            except MediaError as exc:
                record["last_error"] = str(exc)
            self._save(record)
            return self._public(record)
