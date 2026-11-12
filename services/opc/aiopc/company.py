"""A company workspace owns project directories; project paths never escape it."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from aiopc.paths import inside
from aiopc.project import Project


class Company:
    def __init__(self, root: Path):
        self.root = Path(root).expanduser().resolve()

    @classmethod
    def from_directory(cls, directory: Path) -> Company:
        path = Path(directory).expanduser().resolve()
        for current in (path, *path.parents):
            if current.parent.name == "projects":
                return cls(current.parent.parent)
        return cls(path)

    def describe(self) -> dict[str, str]:
        return {"name": self.root.name, "path": str(self.root)}

    @staticmethod
    def project_name(value: str) -> str:
        if not isinstance(value, str):
            raise ValueError("项目名称必须是文字")  # noqa: TRY004 - public validation error
        name = value.strip()
        if (not name or len(name) > 120 or name.startswith(".") or any(char in name for char in '/\\')
                or any(ord(char) < 32 or ord(char) == 127 for char in name)):
            raise ValueError("项目名称需为 1–120 字，不能包含路径或以点开头")
        return name

    def resolve_project(self, value: str) -> Path:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("缺少项目目录")
        base = self.root / "projects"
        if base.is_symlink() or not base.resolve().is_relative_to(self.root):
            raise ValueError("项目目录不能位于公司之外")
        raw = Path(value).expanduser()
        if not raw.is_absolute() and raw.parts and raw.parts[0] != "projects":
            raw = Path("projects") / raw
        if (raw if raw.is_absolute() else self.root / raw).is_symlink():
            raise ValueError("项目目录不能是符号链接")
        target = inside(raw, self.root, [base])
        if target is None or target.parent != base.resolve() or not target.is_dir() or target.name.startswith("."):
            raise ValueError("项目必须是当前公司的 projects/<名称> 目录")
        if self.project_name(target.name) != target.name:
            raise ValueError("项目目录名称不能包含首尾空白")
        if (base / target.name).is_symlink():
            raise ValueError("项目目录不能是符号链接")
        return target

    def project(self, path: Path) -> dict[str, Any]:
        root = self.resolve_project(str(path))
        project = Project(root)
        context = project._read(root / "CONTEXT.md") or ""
        lines = context.splitlines()
        description = next((line.strip() for line in lines[1:] if line.strip() and not line.startswith("#")), "")
        return {"id": f"proj:{root.name}", "name": root.name, "path": str(root), "description": description,
                "company": self.describe(), "brief": {"context": context, "brand": project._read(root / "brand.md"),
                                                      "memory": project._read(root / "MEMORY.md")}}

    def list(self) -> dict[str, Any]:
        base = self.root / "projects"
        projects = []
        if base.is_dir() and not base.is_symlink():
            for path in sorted(base.iterdir(), key=lambda item: item.name.casefold()):
                if path.is_dir() and not path.is_symlink() and not path.name.startswith("."):
                    try:
                        self.resolve_project(str(path))
                    except ValueError:
                        continue
                    projects.append(self.project(path))
        return {"company": self.describe(), "projects": projects}

    def create(self, name: str, description: str = "") -> dict[str, Any]:
        name = self.project_name(name)
        if not isinstance(description, str) or len(description) > 2000:
            raise ValueError("项目介绍不超过 2000 字")
        base = self.root / "projects"
        if base.is_symlink() or not base.resolve().is_relative_to(self.root):
            raise ValueError("项目目录不能位于公司之外")
        # Git establishes the v1 company boundary; the server's v2 plugin
        # additionally filters its skill registry. No files are staged or committed.
        if not (self.root / ".git").exists():
            try:
                subprocess.run(["git", "init", "--quiet", str(self.root)], check=True, timeout=15, capture_output=True)
            except (OSError, subprocess.SubprocessError):
                raise ValueError("无法建立公司的技能目录边界，请确认 Git 可用且公司目录可写") from None
        base.mkdir(parents=True, exist_ok=True)
        target = base / name
        try:
            target.mkdir()
        except FileExistsError:
            raise ValueError("这个项目已存在") from None
        Project(target).init(description)
        return self.project(target)
