"""Lab and project scopes: each owns its own brief, brand, knowledge and assets.

The lab lives in ``workspace/company`` and every product or experiment in
``workspace/projects/<id>``. Scopes exist to manage things separately, not to
hide them: a project brief always includes the lab layer it inherits.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from filelock import FileLock

LAB_ID = "lab"
PROJECT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}\Z")
META_FILE = "project.json"
MAX_BRIEF_FILE_CHARS = 12_000
MAX_KNOWLEDGE_FILES = 200
_KNOWLEDGE_SUFFIXES = {".md", ".txt", ".csv", ".pdf", ".docx", ".xlsx", ".pptx", ".html"}

LAB_SKELETON = {
    "CONTEXT.md": "# 实验室\n\n实验室是谁、在做什么、长期方向。各产品共用的事实写在这里；产品自己的事实写在对应项目里。\n",
    "brand.md": "# 实验室品牌\n\n名称、一句话介绍、语气、视觉要素、不说的话。官号默认沿用；产品可在项目里覆盖。\n",
    "knowledge/README.md": "# 实验室知识库\n\n放各产品都会用到的资料：方法、调研、案例、对外口径。每份资料一个文件。\n",
}
PROJECT_SKELETON = {
    "CONTEXT.md": "# {name}\n\n{description}\n\n## 用户与问题\n\n## 当前阶段与目标\n\n## 已知事实\n\n## 待验证假设\n",
    "brand.md": "# {name} 品牌\n\n只写与实验室不同的部分；没写的沿用实验室品牌。\n",
    "knowledge/README.md": "# {name} 知识库\n\n这个项目专属的资料：竞品、用户反馈、PRD、调研、数据。每份资料一个文件。\n",
}


class ProjectError(ValueError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _stamp() -> str:
    return datetime.now(UTC).isoformat()


def _text(value: Any, field: str, limit: int, *, required: bool = False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str) or len(value) > limit or re.search(r"[\x00-\x08\x0b-\x1f\x7f]", value):
        raise ProjectError(400, f"Invalid {field}")
    value = value.strip()
    if required and not value:
        raise ProjectError(400, f"{field} is required")
    return value


def _write_atomic(path: Path, raw: bytes) -> None:
    fd, temporary = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


class ProjectService:
    def __init__(self, workspace: Path):
        self.workspace = Path(workspace).absolute()

    # ── scopes ────────────────────────────────────────────────────────────
    @staticmethod
    def normalize(project_id: Any) -> str | None:
        """``None``, ``""`` and ``"lab"`` all mean the lab scope."""
        if project_id in (None, "", LAB_ID):
            return None
        if not isinstance(project_id, str) or not PROJECT_ID.fullmatch(project_id):
            raise ProjectError(400, "项目 ID 只能包含字母、数字、短横线和下划线（1–80 个字符）")
        return project_id

    def scope_dir(self, project_id: Any) -> Path:
        project = self.normalize(project_id)
        path = self.workspace / "company" if project is None else self.workspace / "projects" / project
        for parent in (path, *path.parents):
            if parent == self.workspace:
                break
            if parent.is_symlink():
                raise ProjectError(403, "Project directories cannot be symbolic links")
        return path

    def exists(self, project_id: Any) -> bool:
        project = self.normalize(project_id)
        return project is None or self.scope_dir(project).is_dir()

    def require(self, project_id: Any) -> str | None:
        project = self.normalize(project_id)
        if project is not None and not self.scope_dir(project).is_dir():
            raise ProjectError(404, f"项目不存在：{project}")
        return project

    def _meta(self, project_id: str) -> dict[str, Any]:
        path = self.scope_dir(project_id) / META_FILE
        try:
            raw = json.loads(path.read_text(encoding="utf-8")) if path.is_file() and not path.is_symlink() else {}
        except (OSError, ValueError):
            raw = {}
        return raw if isinstance(raw, dict) else {}

    def describe(self, project_id: Any) -> dict[str, Any]:
        project = self.require(project_id)
        if project is None:
            meta = self._meta_lab()
            return {"id": LAB_ID, "kind": "lab", "name": meta.get("name") or "实验室",
                    "description": meta.get("description", ""), "path": str(self.scope_dir(None))}
        meta = self._meta(project)
        return {"id": project, "kind": "project", "name": meta.get("name") or project,
                "description": meta.get("description", ""), "created_at": meta.get("created_at"),
                "path": str(self.scope_dir(project))}

    def _meta_lab(self) -> dict[str, Any]:
        path = self.scope_dir(None) / META_FILE
        try:
            raw = json.loads(path.read_text(encoding="utf-8")) if path.is_file() and not path.is_symlink() else {}
        except (OSError, ValueError):
            raw = {}
        return raw if isinstance(raw, dict) else {}

    def list(self) -> list[dict[str, Any]]:
        root = self.workspace / "projects"
        projects: list[dict[str, Any]] = []
        if root.is_dir() and not root.is_symlink():
            with os.scandir(root) as entries:
                for entry in entries:
                    if PROJECT_ID.fullmatch(entry.name) and entry.name != LAB_ID and entry.is_dir(follow_symlinks=False):
                        projects.append(self.describe(entry.name))
        projects.sort(key=lambda item: item["name"].casefold())
        return [self.describe(None), *projects]

    # ── mutations ─────────────────────────────────────────────────────────
    def _lock(self) -> FileLock:
        lock = self.workspace / "projects" / ".projects.lock"
        lock.parent.mkdir(parents=True, exist_ok=True)
        return FileLock(str(lock), timeout=5)

    def ensure_skeleton(self, project_id: Any) -> list[str]:
        """Create missing starter files; never overwrite anything the user wrote."""
        project = self.require(project_id)
        root = self.scope_dir(project)
        info = self.describe(project)
        template = LAB_SKELETON if project is None else PROJECT_SKELETON
        created = []
        for relative, text in template.items():
            path = root / relative
            if path.exists() or path.is_symlink():
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            body = text.format(name=info["name"], description=info["description"] or "一句话说明这个项目。")
            with path.open("x", encoding="utf-8") as stream:
                stream.write(body)
            created.append(relative)
        (root / "assets").mkdir(parents=True, exist_ok=True)
        return created

    def new_id(self, name: str) -> str:
        """A readable folder name from the project name; names without Latin letters get a short code."""
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40].strip("-")
        base = slug if slug and slug != LAB_ID else "project"
        candidate = base if slug else f"{base}-{uuid.uuid4().hex[:6]}"
        while (self.workspace / "projects" / candidate).exists():
            candidate = f"{base}-{uuid.uuid4().hex[:6]}"
        return candidate

    def create(self, project_id: Any = None, name: Any = "", description: Any = "") -> dict[str, Any]:
        name = _text(name, "name", 120)
        if project_id in (None, ""):
            if not name:
                raise ProjectError(400, "请填写项目名称")
            project_id = self.new_id(name)
        project = self.normalize(project_id)
        if project is None:
            raise ProjectError(400, "“lab” 是实验室保留名，请换一个项目 ID")
        name = name or project
        description = _text(description, "description", 2000)
        with self._lock():
            root = self.scope_dir(project)
            if root.exists():
                raise ProjectError(409, f"项目已存在：{project}")
            root.mkdir(parents=True)
            _write_atomic(root / META_FILE, self._meta_bytes({"name": name, "description": description, "created_at": _stamp()}))
        self.ensure_skeleton(project)
        return self.describe(project)

    def update(self, project_id: Any, name: Any = None, description: Any = None) -> dict[str, Any]:
        project = self.require(project_id)
        with self._lock():
            meta = self._meta_lab() if project is None else self._meta(project)
            if name is not None:
                meta["name"] = _text(name, "name", 120, required=True)
            if description is not None:
                meta["description"] = _text(description, "description", 2000)
            meta["updated_at"] = _stamp()
            root = self.scope_dir(project)
            root.mkdir(parents=True, exist_ok=True)
            _write_atomic(root / META_FILE, self._meta_bytes(meta))
        return self.describe(project)

    @staticmethod
    def _meta_bytes(meta: dict[str, Any]) -> bytes:
        return (json.dumps(meta, ensure_ascii=False, indent=2) + "\n").encode()

    # ── account voices ───────────────────────────────────────────────────
    def voice_path(self, account: dict[str, Any]) -> Path:
        """An account's voice lives with its owner, so moving ownership is explicit."""
        return self.scope_dir(account.get("project_id")) / "accounts" / f"{account['id']}.md"

    def ensure_voice(self, account: dict[str, Any]) -> Path:
        path = self.voice_path(account)
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            label = account.get("alias") or account.get("name") or account["id"]
            with path.open("x", encoding="utf-8") as stream:
                stream.write(
                    f"# {label} 的人设与文风\n\n"
                    "这个账号以谁的身份说话、对谁说、语气、常用表达、不说的话、发帖频率。\n"
                    "为同一份原稿准备多个账号的版本时，按这里调整口吻；事实仍以项目资料为准。\n"
                )
        return path

    # ── agent brief ──────────────────────────────────────────────────────
    def _read(self, path: Path) -> str | None:
        if not path.is_file() or path.is_symlink():
            return None
        text = path.read_text(encoding="utf-8", errors="replace")
        return text if len(text) <= MAX_BRIEF_FILE_CHARS else text[:MAX_BRIEF_FILE_CHARS] + "\n[已截断；读取原文件获取全文]"

    def _knowledge(self, root: Path) -> list[dict[str, Any]]:
        base = root / "knowledge"
        if not base.is_dir() or base.is_symlink():
            return []
        found = []
        for directory, folders, files in os.walk(base):
            folders[:] = [name for name in folders if not name.startswith(".") and not (Path(directory) / name).is_symlink()]
            for name in sorted(files):
                path = Path(directory) / name
                if name.startswith(".") or path.is_symlink() or path.suffix.lower() not in _KNOWLEDGE_SUFFIXES:
                    continue
                found.append({"path": str(path), "name": str(path.relative_to(base)), "size": path.stat().st_size})
                if len(found) >= MAX_KNOWLEDGE_FILES:
                    return found
        return found

    def _layer(self, project: str | None) -> dict[str, Any]:
        root = self.scope_dir(project)
        return {
            **self.describe(project),
            "context": self._read(root / "CONTEXT.md"),
            "brand": self._read(root / "brand.md"),
            "knowledge": self._knowledge(root),
            "assets_dir": str(root / "assets"),
            "content_rules_dir": str(root / "content-rules"),
        }

    def brief(self, project_id: Any, accounts: list[dict[str, Any]]) -> dict[str, Any]:
        project = self.require(project_id)
        layers = [self._layer(None)] if project is None else [self._layer(None), self._layer(project)]
        usable = []
        for account in accounts:
            voice = self.voice_path(account)
            usable.append({**account, "voice_path": str(voice), "voice": self._read(voice)})
        return {
            "project": self.describe(project),
            "layers": layers,
            "accounts": usable,
            "guidance": (
                "Layers are ordered lab → project; a project overrides the lab where they differ. "
                "Use only accounts listed here for this project. Owner accounts speak for themselves; "
                "shared accounts (e.g. lab official) amplify or repost with their own voice."
            ),
        }


def account_usable_by(record: dict[str, Any], project_id: str | None) -> bool:
    """Owner scope, or explicitly shared with this scope or with every scope."""
    if record.get("kind") != "account":
        return False
    shared = record.get("shared_with") or []
    target = project_id or LAB_ID
    return (record.get("project_id") or None) == project_id or "*" in shared or target in shared
