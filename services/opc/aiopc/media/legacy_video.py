"""Assign explicitly selected legacy video jobs to a project."""

from __future__ import annotations

import json
import os
import stat
import tempfile
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from filelock import FileLock
from filelock import Timeout as FileLockTimeout

from aiopc.media.video import JOB_ID, LEGACY_JOB_ARCHIVE


def _directory(path: Path) -> bool:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(mode):
        raise ValueError("视频迁移目录必须是普通目录")
    return True


def _regular_file(path: Path) -> bool:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(mode):
        raise ValueError("视频迁移只接受普通文件")
    return True


def _read_record(path: Path, job_id: str) -> tuple[bytes, dict[str, Any]]:
    if not _regular_file(path):
        raise ValueError(f"找不到视频任务 {job_id}")
    try:
        data = path.read_bytes()
        record = json.loads(data)
    except (OSError, UnicodeError, ValueError, RecursionError):
        raise ValueError(f"无法读取视频任务 {job_id}") from None
    # Match the runtime's required record fields without loading gateway configuration.
    string_fields = ("task_id", "video_url", "path", "mime", "error", "last_error", "fingerprint")
    if (not isinstance(record, dict) or record.get("id") != job_id
            or not isinstance(record.get("status"), str) or not isinstance(record.get("model"), str)
            or not isinstance(record.get("created_at"), (float, int))
            or any(key in record and not isinstance(record[key], str) for key in string_fields)
            or (record.get("workspace") is not None and not isinstance(record["workspace"], str))):
        raise ValueError(f"视频任务 {job_id} 的记录无效")
    return data, record


def _download_source(path_value: str, source: Path, cache: Path, job_id: str) -> Path | None:
    path = Path(path_value)
    if not path.is_absolute() or "\x00" in path_value or ".." in path.parts or path.suffix.lower() not in {".mp4", ".mov"}:
        raise ValueError(f"视频任务 {job_id} 的下载文件路径无效")
    if path.is_relative_to(cache) and (path.parent != cache or path.stem != job_id):
        raise ValueError(f"视频任务 {job_id} 的下载文件属于其他任务")
    for base in (cache, source):
        if path == base or not path.is_relative_to(base):
            continue
        parent = base
        for component in path.relative_to(base).parts[:-1]:
            if not _directory(parent):
                return None
            parent /= component
        if not _directory(parent):
            return None
        return path if _regular_file(path) else None
    raise ValueError(f"视频任务 {job_id} 的下载文件不属于旧工作区或视频缓存")


def _validate_backup(path: Path, data: bytes, job_id: str) -> bool:
    if not _directory(path.parent) or not _regular_file(path):
        return False
    if stat.S_IMODE(path.lstat().st_mode) != 0o600 or path.read_bytes() != data:
        raise ValueError(f"视频任务 {job_id} 的原件备份冲突")
    return True


def _write_private(path: Path, data: bytes, *, replace: bool) -> None:
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".video-migration-")
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@dataclass(frozen=True)
class VideoAssignment:
    job_id: str
    source_file: Path | None = None
    destination: Path | None = None
    _record: Path | None = field(default=None, repr=False)
    _archive: Path | None = field(default=None, repr=False)
    _original: bytes = field(default=b"", repr=False)
    _updated: bytes = field(default=b"", repr=False)
    _lock: FileLock | None = field(default=None, repr=False)

    @property
    def action(self) -> str:
        return "assign" if self._record is not None else "unchanged"

    def apply(self) -> None:
        if self._record is None or self._archive is None:
            return
        if self._lock is None or not self._lock.is_locked:
            raise ValueError(f"视频任务 {self.job_id} 的迁移锁未持有")
        if self.destination is not None and not _regular_file(self.destination):
            raise ValueError(f"视频任务 {self.job_id} 的下载文件尚未复制")
        current, _ = _read_record(self._record, self.job_id)
        if current != self._original:
            raise ValueError(f"视频任务 {self.job_id} 的记录已变化，请重新预演")
        if not _validate_backup(self._archive, current, self.job_id):
            self._archive.parent.mkdir(mode=0o700, exist_ok=True)
            _write_private(self._archive, current, replace=False)
        _write_private(self._record, self._updated, replace=True)


def plan_videos(
    home: Path, source: Path, target: Path, selected: list[str], *, locks: ExitStack | None,
) -> tuple[list[VideoAssignment], list[str]]:
    """Read-only when no ExitStack is supplied. Hold runtime locks until the caller exits its stack."""
    selected = list(dict.fromkeys(selected))
    if any(not JOB_ID.fullmatch(job_id) for job_id in selected):
        raise ValueError("视频任务编号必须为 vid_ 加 24 位小写十六进制字符")

    root = home / "media" / "video"
    jobs, cache, archive = root / "jobs", root / "files", root / LEGACY_JOB_ARCHIVE
    if not all(_directory(directory) for directory in (home, root.parent, root, jobs)):
        if selected:
            raise ValueError("找不到所选视频任务的记录目录")
        return [], []

    assignments = []
    for job_id in selected:
        path = jobs / f"{job_id}.json"
        if not _regular_file(path):
            raise ValueError(f"找不到视频任务 {job_id}")
        lock_path = path.with_suffix(".lock")
        if _regular_file(lock_path) and lock_path.lstat().st_nlink != 1:
            raise ValueError(f"视频任务 {job_id} 的锁文件无效")
        lock = None
        if locks is not None:
            lock = FileLock(lock_path, timeout=0, thread_local=False, mode=0o600)
            try:
                locks.enter_context(lock)
            except FileLockTimeout:
                raise ValueError(f"视频任务 {job_id} 正在使用，请稍后重试") from None
        original, record = _read_record(path, job_id)
        owner = record.get("workspace")
        if owner == str(target):
            assignments.append(VideoAssignment(job_id))
            continue
        if owner not in (None, str(source)):
            raise ValueError(f"视频任务 {job_id} 已属于其他项目")

        backup = archive / path.name
        _validate_backup(backup, original, job_id)
        cached_file = destination = None
        if record.get("path"):
            cached_file = _download_source(record["path"], source, cache, job_id)
            if cached_file is not None:
                destination = target / "assets" / "generated" / f"{job_id}{cached_file.suffix.lower()}"
                record["path"] = str(destination)
            else:
                for key in ("path", "mime", "bytes"):
                    record.pop(key, None)
        record["workspace"] = str(target)
        updated = json.dumps(record, ensure_ascii=True, indent=2).encode()
        assignments.append(VideoAssignment(job_id, cached_file, destination, path, backup, original, updated, lock))

    unassigned = []
    for path in sorted(jobs.glob("vid_*.json")):
        job_id = path.stem
        if not JOB_ID.fullmatch(job_id) or job_id in selected:
            continue
        try:
            _, record = _read_record(path, job_id)
        except ValueError:
            continue
        if record.get("workspace") is None:
            unassigned.append(job_id)
    return assignments, unassigned
