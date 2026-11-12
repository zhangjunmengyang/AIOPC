"""Persistent mirror records and content integrity checks."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

from .audit import AuditResult

_ID = re.compile(r"[0-9a-f]{24}\Z")
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_MANIFEST = "skills-manifest.json"


@dataclass(frozen=True)
class SkillRecord:
    id: str
    repository: str
    commit: str
    source_path: str
    source_url: str
    license: str | None
    categories: tuple[str, ...]
    names: dict[str, tuple[str, ...]]
    descriptions: dict[str, tuple[str, ...]]
    has_scripts: bool
    content_hash: str
    specification: AuditResult
    scan: AuditResult
    title: str

    @classmethod
    def from_dict(cls, data: dict) -> SkillRecord:
        return cls(**{
            **data,
            "categories": tuple(data["categories"]),
            "names": {lang: tuple(items) for lang, items in data["names"].items()},
            "descriptions": {lang: tuple(items) for lang, items in data["descriptions"].items()},
            "specification": _audit(data["specification"]),
            "scan": _audit(data["scan"]),
        })


def _audit(data: dict) -> AuditResult:
    return AuditResult(data["status"], tuple(data["details"]))


def skill_id(repository: str, source_path: str, commit: str) -> str:
    return hashlib.sha256(f"{repository}\0{source_path}\0{commit}".encode()).hexdigest()[:24]


def skill_content(root: Path, record: SkillRecord) -> Path:
    if not _ID.fullmatch(record.id) or not _HASH.fullmatch(record.content_hash):
        raise ValueError("技能标识或内容 hash 无效")
    destination = root.resolve() / "skills-mirror" / record.id / record.content_hash
    if destination.resolve() != destination:
        raise ValueError("技能镜像路径包含符号链接")
    return destination


def hash_skill(directory: Path) -> str:
    """Hash regular-file paths and bytes independently of timestamps or the checkout location."""
    if not stat.S_ISDIR(directory.lstat().st_mode):
        raise ValueError("技能目录无效")
    digest = hashlib.sha256()
    for path in sorted(directory.rglob("*"), key=lambda path: path.relative_to(directory).as_posix()):
        relative = path.relative_to(directory)
        mode = path.lstat().st_mode
        if any(part.casefold() == ".git" for part in relative.parts):
            raise ValueError(f"技能含 Git 元数据：{relative}")
        if stat.S_ISDIR(mode):
            continue
        if not stat.S_ISREG(mode):
            raise ValueError(f"技能含非普通文件：{relative}")
        with path.open("rb") as stream:
            file_hash = hashlib.file_digest(stream, "sha256").digest()
        digest.update(relative.as_posix().encode("utf-8") + b"\0" + file_hash)
    return digest.hexdigest()


def atomic_text(path: Path, text: str) -> None:
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".skillhub-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def write_manifest(root: Path, skills: dict[str, SkillRecord], repositories: dict, catalog: dict) -> None:
    payload = {"version": 1, "repositories": repositories, "catalog": catalog,
               "skills": {key: asdict(value) for key, value in skills.items()}}
    atomic_text(root / _MANIFEST, json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")


def read_manifest(root: Path) -> dict:
    try:
        payload = json.loads((root / _MANIFEST).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"version": 1, "repositories": {}, "catalog": {}, "skills": {}}
    if payload["version"] != 1:
        raise ValueError("技能镜像清单版本不受支持")
    return payload


def read_skills(root: Path) -> dict[str, SkillRecord]:
    return {key: SkillRecord.from_dict(data) for key, data in read_manifest(root)["skills"].items()}
