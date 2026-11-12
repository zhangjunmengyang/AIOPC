"""复制旧工作区的项目文件，并按明确指定的任务 ID 归档旧视频。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import sys
import tempfile
import unicodedata
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path

from filelock import FileLock
from filelock import Timeout as LockTimeout

from aiopc.company import Company
from aiopc.media.legacy_video import VideoAssignment, plan_videos
from aiopc.project import SKELETON, Project

ROOT_FILES = ("CONTEXT.md", "brand.md", "marketing-plan.md", "decisions.md", "MEMORY.md", "STATE.md")
PROJECT_FOLDERS = ("knowledge", "content-rules", "assets", "content", "research", "campaigns")
PUBLISH_HISTORY = Path("social/log.jsonl")


def _mode(path: Path) -> int:
    try:
        return path.lstat().st_mode
    except FileNotFoundError:
        return 0


def _directory(root: Path, relative: Path) -> bool:
    """Check every component before traversing an existing directory."""
    for part in relative.parts:
        root /= part
        mode = _mode(root)
        if not mode:
            return False
        if not stat.S_ISDIR(mode):
            raise ValueError(f"需要普通目录，发现文件或链接 {root}")
    return True


def _regular(path: Path) -> bool:
    mode = _mode(path)
    if mode and not stat.S_ISREG(mode):
        raise ValueError(f"需要普通文件，发现目录或链接 {path}")
    return bool(mode)


def _same_contents(left: Path, right: Path) -> bool:
    if left.stat().st_size != right.stat().st_size:
        return False
    with left.open("rb") as source, right.open("rb") as destination:
        return hashlib.file_digest(source, "sha256").digest() == hashlib.file_digest(destination, "sha256").digest()


def _roots(source: Path, company: Path, project: str) -> tuple[Path, Company, Path]:
    if not stat.S_ISDIR(_mode(source)) or not stat.S_ISDIR(_mode(company)):
        raise ValueError("旧工作区和公司目录必须是已存在的普通目录")
    source = source.resolve()
    company = Company(company)
    if source.is_relative_to(company.root) or company.root.is_relative_to(source):
        raise ValueError("请使用互不包含的旧工作区和公司目录，以免旧资料被当作公司共享知识")
    relative = Path("projects") / company.project_name(project)
    target = company.root / relative
    if _directory(company.root, relative):
        if target.name not in {entry.name for entry in target.parent.iterdir()}:
            raise ValueError("目标项目已存在，请使用目录中显示的项目名")
        company.resolve_project(str(target))
    return source, company, target


def _source_files(source: Path) -> tuple[dict[Path, Path], set[Path]]:
    files: dict[Path, Path] = {}
    folders: set[Path] = set()
    for name in ROOT_FILES:
        path = source / name
        if _regular(path):
            files[Path(name)] = path

    pending = [Path(name) for name in PROJECT_FOLDERS if _directory(source, Path(name))]
    while pending:
        relative = pending.pop()
        folders.add(relative)
        for path in sorted((source / relative).iterdir()):
            if path.name.startswith("."):
                continue
            child = relative / path.name
            if stat.S_ISDIR(_mode(path)):
                pending.append(child)
            elif _regular(path):
                files[child] = path

    if _directory(source, Path("accounts")):
        for path in sorted((source / "accounts").glob("*.md")):
            if not path.name.startswith(".") and _regular(path):
                files[path.relative_to(source)] = path

    if _directory(source, PUBLISH_HISTORY.parent) and _regular(source / PUBLISH_HISTORY):
        path = source / PUBLISH_HISTORY
        with path.open(encoding="utf-8") as stream:
            for number, line in enumerate(stream, start=1):
                if not line.strip():
                    continue
                try:
                    valid = isinstance(json.loads(line), dict)
                except ValueError:
                    valid = False
                if not valid:
                    raise ValueError(f"{PUBLISH_HISTORY} 第 {number} 行不是有效的发布记录")
        files[PUBLISH_HISTORY] = path

    return files, folders


@dataclass
class Migration:
    source: Path
    company: Company
    target: Path
    files: dict[Path, Path]
    directories: list[Path]
    copies: set[Path]
    starter_files: list[Path]
    videos: list[VideoAssignment]
    unassigned: list[str]

    def describe(self, dry_run: bool) -> dict:
        return {
            "mode": "dry-run" if dry_run else "apply",
            "source": str(self.source),
            "target": str(self.target),
            "directories": [path.as_posix() for path in self.directories],
            "files": [{"path": path.as_posix(), "action": "copy" if path in self.copies else "unchanged"} for path in self.files],
            "initialize": [path.as_posix() for path in self.starter_files],
            "video_jobs": [{"id": job.job_id, "action": job.action} for job in self.videos],
            "unassigned_video_jobs": self.unassigned,
        }

    def apply(self) -> None:
        self.company.prepare_projects()
        self.target.mkdir(exist_ok=True)
        for relative in self.directories:
            (self.target / relative).mkdir(exist_ok=True)
        for relative in sorted(self.copies):
            _copy_new(self.files[relative], self.target / relative)
        Project(self.target).init()
        for assignment in self.videos:
            assignment.apply()


def _copy_new(source: Path, target: Path) -> None:
    # A temporary sibling keeps partial writes out of the project file. The hard
    # link publishes atomically and cannot replace a file created after planning.
    with tempfile.NamedTemporaryFile(prefix=".aiopc-migrate-", dir=target.parent, delete=False) as stream:
        temporary = Path(stream.name)
    try:
        shutil.copy2(source, temporary, follow_symlinks=False)
        try:
            os.link(temporary, target, follow_symlinks=False)
        except FileExistsError:
            if not _regular(target) or not _same_contents(temporary, target):
                raise ValueError(f"复制时发现目标冲突 {target}") from None
    finally:
        temporary.unlink(missing_ok=True)


def _plan(
    source: Path, company: Company, target: Path, home: Path | None, selected: list[str], locks: ExitStack | None,
) -> Migration:
    files, folders = _source_files(source)
    videos, unassigned = plan_videos(home, source, target, selected, locks=locks) if home is not None else ([], [])
    for job in videos:
        if job.source_file is not None and job.destination is not None:
            relative = job.destination.relative_to(target)
            if relative in files and not _same_contents(files[relative], job.source_file):
                raise ValueError(f"旧素材和视频缓存内容不同 {relative}")
            files.setdefault(relative, job.source_file)

    starters = {Path(path) for path in SKELETON}
    folders.add(Path("assets"))
    for path in [*files, *starters, *folders]:
        folders.update(parent for parent in path.parents if parent != Path("."))
    # A plan can include files from two volumes. Reject case/Unicode aliases
    # before copying even when the current filesystem distinguishes them.
    seen: dict[str, Path] = {}
    for path in sorted(set(files) | starters | folders):
        key = unicodedata.normalize("NFC", path.as_posix()).casefold()
        previous = seen.setdefault(key, path)
        if previous != path or (path in folders and (path in files or path in starters)):
            raise ValueError(f"目标路径冲突 {previous} 与 {path}")

    directories = [relative for relative in sorted(folders, key=lambda path: (len(path.parts), path))
                   if not _directory(target, relative)]
    copies = set()
    for relative, original in files.items():
        destination = target / relative
        if not _regular(destination):
            copies.add(relative)
        elif not _same_contents(original, destination):
            raise ValueError(f"目标文件内容不同 {destination}")
    starter_files = sorted(path for path in starters - files.keys() if not _regular(target / path))
    return Migration(source, company, target, dict(sorted(files.items())), directories, copies, starter_files, videos, unassigned)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog="先运行 --dry-run，确认后用同一命令去掉 --dry-run。执行时请退出 AIOPC，暂停写入旧工作区。",
    )
    parser.add_argument("--source", type=Path, required=True, help="旧工作区目录")
    parser.add_argument("--company", type=Path, required=True, help="已存在的公司工作区目录")
    parser.add_argument("--project", required=True, help="公司 projects 下的目标项目名")
    parser.add_argument("--dry-run", action="store_true", help="只检查并输出计划")
    parser.add_argument("--video-home", type=Path, help="旧 AIOPC 实例数据目录，例如 ~/.aiopc")
    parser.add_argument("--video-job", action="append", default=[], metavar="ID", help="明确归属给项目的视频任务，可多次指定")
    args = parser.parse_args(argv)
    if args.video_job and args.video_home is None:
        parser.error("--video-job 需要同时指定 --video-home")

    try:
        source, company, target = _roots(args.source.expanduser(), args.company.expanduser(), args.project)
        home = args.video_home.expanduser() if args.video_home is not None else None
        if home is not None:
            if not stat.S_ISDIR(_mode(home)):
                raise ValueError("--video-home 必须是已存在的普通目录")
            home = home.resolve()
        plan = _plan(source, company, target, home, args.video_job, None)
        if not args.dry_run:
            lock_path = company.root / ".aiopc-workspace-migration.lock"
            if _regular(lock_path) and lock_path.lstat().st_nlink != 1:
                raise ValueError("迁移锁文件无效")
            with FileLock(lock_path, timeout=0, mode=0o600), ExitStack() as locks:
                source, company, target = _roots(source, company.root, args.project)
                plan = _plan(source, company, target, home, args.video_job, locks)
                plan.apply()
    except LockTimeout:
        print("已有迁移在使用此目录，请等它结束后重试", file=sys.stderr)
        return 1
    except (OSError, ValueError) as exc:
        print(f"迁移停止：{exc}", file=sys.stderr)
        return 1
    print(json.dumps(plan.describe(args.dry_run), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
