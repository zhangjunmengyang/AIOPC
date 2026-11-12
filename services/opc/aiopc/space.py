"""The Space catalog: a project's documents, media and knowledge. The workspace folder is the project."""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path
from typing import Any

from aiopc.project import Project

KINDS = {
    "image": {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"},
    "video": {".mp4", ".webm", ".mov", ".m4v"},
    "audio": {".mp3", ".wav", ".m4a", ".ogg", ".flac"},
    "document": {".md", ".markdown", ".txt", ".rst", ".csv", ".pdf", ".docx", ".xlsx", ".pptx", ".html", ".htm", ".json"},
}
SKIP_DIRS = {"node_modules", "__pycache__", "social", "dist", "build", "venv"}
MAX_ITEMS = 2000
MAX_DEPTH = 8


def kind_of(path: Path) -> str | None:
    suffix = path.suffix.lower()
    return next((kind for kind, suffixes in KINDS.items() if suffix in suffixes), None)


def section_of(relative: Path) -> str:
    """Where a file sits inside its scope: brief, knowledge, assets, content or other."""
    first = relative.parts[0] if len(relative.parts) > 1 else ""
    if relative.name in {"CONTEXT.md", "brand.md", "marketing-plan.md", "MEMORY.md", "decisions.md", "STATE.md"} and len(relative.parts) == 1:
        return "brief"
    return {"knowledge": "knowledge", "content-rules": "knowledge", "assets": "assets", "content": "content",
            "accounts": "voices"}.get(first, "other")


class SpaceCatalog:
    def __init__(self, workspace: Path):
        self.workspace = Path(workspace)
        self.project = Project(self.workspace)

    def files(self, *, exclude_top: frozenset[str] = frozenset()) -> dict[str, Any]:
        root = self.workspace
        items: list[dict[str, Any]] = []
        truncated = False
        if root.is_dir():
            pending = [(root, 0)]
            while pending:
                directory, depth = pending.pop()
                try:
                    entries = list(os.scandir(directory))
                except OSError:
                    continue
                for entry in entries:
                    if entry.name.startswith(".") or entry.is_symlink():
                        continue
                    path = Path(entry.path)
                    if entry.is_dir(follow_symlinks=False):
                        if entry.name in SKIP_DIRS or depth >= MAX_DEPTH or (depth == 0 and entry.name in exclude_top):
                            continue
                        pending.append((path, depth + 1))
                        continue
                    kind = kind_of(path)
                    if kind is None or (depth == 0 and entry.name in {"AGENTS.md", "package.json", "package-lock.json"}):
                        continue
                    if len(items) >= MAX_ITEMS:
                        truncated = True
                        break
                    try:
                        info = entry.stat(follow_symlinks=False)
                    except OSError:
                        # A file may disappear while a live knowledge catalog is scanning.
                        continue
                    relative = path.relative_to(root)
                    items.append({"path": str(path), "relative": relative.as_posix(), "name": path.name, "kind": kind,
                                  "section": section_of(relative), "size": info.st_size, "modified": info.st_mtime})
        items.sort(key=lambda item: item["modified"], reverse=True)
        return {"project": self.project.describe(), "items": items, "truncated": truncated}

    def resolve(self, path: str) -> Path:
        """A file inside the workspace; never anything hidden or outside it."""
        target = Path(path).expanduser().resolve()
        workspace = self.workspace.resolve()
        if not target.is_relative_to(workspace) or not target.is_file():
            raise ValueError("文件不在工作区内或不存在")
        relative = target.relative_to(workspace).parts
        if not relative or any(part.startswith(".") for part in relative):
            raise ValueError("不能访问隐藏文件")
        return target

    @staticmethod
    def mime(path: Path) -> str:
        return mimetypes.guess_type(path.name)[0] or "application/octet-stream"

