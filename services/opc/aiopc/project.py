"""Files belonging to one project below a company workspace.

Company resolves project identity and boundaries; this class reads and writes
the selected project's brief, brand, memory, knowledge, assets and drafts.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

MAX_BRIEF_FILE_CHARS = 12_000
MAX_KNOWLEDGE_FILES = 200
_KNOWLEDGE_SUFFIXES = {".md", ".txt", ".csv", ".pdf", ".docx", ".xlsx", ".pptx", ".html"}

SKELETON = {
    "CONTEXT.md": "# {name}\n\n{description}\n\n## 用户与问题\n\n## 当前阶段与目标\n\n## 已知事实\n\n## 待验证假设\n",
    "brand.md": "# {name} 品牌\n\n名称、一句话介绍、语气、视觉要素、不说的话。\n",
    "MEMORY.md": "# {name} 记忆\n\n## 最近进展\n\n## 关键决定\n",
    "knowledge/README.md": "# {name} 知识库\n\n这个项目的资料：竞品、用户反馈、PRD、调研、数据。每份资料一个文件。\n",
}


class ProjectError(ValueError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class Project:
    def __init__(self, root: Path):
        self.root = Path(root).absolute()

    @property
    def name(self) -> str:
        return self.root.name

    def describe(self) -> dict[str, Any]:
        return {"name": self.name, "path": str(self.root)}

    @property
    def assets(self) -> Path:
        return self.root / "assets"

    @property
    def social(self) -> Path:
        return self.root / "social"

    def init(self, description: str = "") -> dict[str, Any]:
        """Starter brief, brand, memory and knowledge files; existing files are never overwritten."""
        if not isinstance(description, str) or len(description) > 2000:
            raise ProjectError(400, "项目介绍不超过 2000 字")
        # Check every destination before creating anything, including directory
        # symlinks whose leaf file does not exist yet.
        for relative in [*SKELETON, "assets"]:
            path = self.root / relative
            if path.is_symlink() or not path.resolve().is_relative_to(self.root.resolve()):
                raise ProjectError(400, "项目初始化不能通过符号链接写入项目外目录")
        created = []
        for relative, template in SKELETON.items():
            path = self.root / relative
            if path.exists():
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(template.format(name=self.name, description=description.strip()), encoding="utf-8")
            created.append(relative)
        self.assets.mkdir(exist_ok=True)
        return {**self.describe(), "created": created}

    # ── account voices: how a shared account speaks for this project ─────
    def voice_path(self, account: dict[str, Any]) -> Path:
        return self.root / "accounts" / f"{account['id']}.md"

    # ── agent brief ──────────────────────────────────────────────────────
    def _read(self, path: Path) -> str | None:
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(self.root.resolve()):
            return None
        text = path.read_text(encoding="utf-8", errors="replace")
        return text if len(text) <= MAX_BRIEF_FILE_CHARS else text[:MAX_BRIEF_FILE_CHARS] + "\n[已截断；读取原文件获取全文]"

    def _knowledge(self) -> list[dict[str, Any]]:
        base = self.root / "knowledge"
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

    def brief(self, accounts: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "project": self.describe(),
            "context": self._read(self.root / "CONTEXT.md"),
            "brand": self._read(self.root / "brand.md"),
            "memory": self._read(self.root / "MEMORY.md"),
            "knowledge": self._knowledge(),
            "assets_dir": str(self.assets),
            "accounts": [{**account, "voice_path": str(self.voice_path({"id": account["account_id"]})),
                          "voice": self._read(self.voice_path({"id": account["account_id"]}))} for account in accounts],
            "guidance": (
                "This is the selected project's directory under its company workspace. "
                "Missing files mean nothing is known yet: ask, or use init_project. "
                "Only accounts owned by this project are listed; accounts/ contains this project's account voices."
            ),
        }
