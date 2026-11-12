"""Install an audited snapshot into the caller's authorized OpenCode skill root."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import stat
import tempfile
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Literal

import yaml
from filelock import FileLock
from filelock import Timeout as LockTimeout

from .audit import validate_skill
from .manifest import SkillRecord, atomic_text, hash_skill, read_skills, skill_content
from .upstream import is_script

_LOCK_VERSION = 1


def _company_root(company: Path) -> Path:
    if company.is_symlink() or not company.is_dir():
        raise ValueError("公司目录无效")
    return company.resolve(strict=True)


def _project_root(company: Path, company_root: Path, project: Path) -> Path:
    projects = company_root / "projects"
    if (project.parent not in {company / "projects", projects} or projects.is_symlink()
            or project.is_symlink() or not project.is_dir() or project.name.startswith(".")):
        raise ValueError("目标必须是当前公司的 projects/<名称> 目录")
    return projects / project.name


def _target(company: Path, project: Path | None, scope: str, *, can_adopt_company: bool) -> Path:
    company_root = _company_root(company)
    if scope == "company":
        if not can_adopt_company or project is not None:
            raise ValueError("采纳为公司技能需要公司级授权")
        return company_root
    if scope != "project" or project is None:
        raise ValueError("采纳项目技能需要当前项目")
    return _project_root(company, company_root, project)


def _directory(path: Path) -> None:
    path.mkdir(mode=0o700, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise ValueError(f"技能目录无效：{path.name}")


def _lock_path(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError(f"技能锁路径无效：{path.name}")


def _read_lock(path: Path) -> dict:
    _lock_path(path)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"version": _LOCK_VERSION, "skills": {}}
    except (UnicodeError, ValueError) as exc:
        raise ValueError("skills-lock.json 无法读取") from exc
    if (not isinstance(value, dict) or value.get("version") != _LOCK_VERSION
            or not isinstance(value.get("skills"), dict) or not all(isinstance(item, dict) for item in value["skills"].values())):
        raise ValueError("skills-lock.json 格式无效")
    return value


def _write_lock(path: Path, value: dict) -> None:
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def _check_hash(directory: Path, record: SkillRecord) -> None:
    if directory.is_symlink() or not directory.is_dir() or hash_skill(directory) != record.content_hash:
        raise ValueError("技能内容与锁定的 hash 不一致")


def _check_scripts(directory: Path) -> None:
    # Also verify the package itself. Mirror metadata keeps the upstream Git
    # executable bits even though mirror files have their execute bits removed.
    for path in directory.rglob("*"):
        relative = path.relative_to(directory).as_posix()
        if path.is_dir():
            scripted = is_script(relative, b"")
        else:
            with path.open("rb") as stream:
                scripted = is_script(relative, stream.read(512), executable=bool(path.stat().st_mode & 0o111))
        if scripted:
            raise ValueError("此技能包含脚本，需要可隔离执行的项目沙箱")


def installed_skill_name(record: SkillRecord) -> str:
    original_directory = PurePosixPath(record.source_path).parent.name or record.repository.rstrip("/").rsplit("/", 1)[-1]
    return unicodedata.normalize("NFKC", original_directory)


def _skill_source(directory: Path, record: SkillRecord) -> tuple[str, str, str]:
    text = (directory / "SKILL.md").read_text(encoding="utf-8-sig")
    fields, spec = validate_skill(text, installed_skill_name(record))
    if spec.status != "passed":
        raise ValueError("技能名称或 SKILL.md 与上游目录不匹配")
    lines = text.split("\n")
    end = next(i for i, line in enumerate(lines[1:], 1) if line.rstrip(" \t") == "---")
    return unicodedata.normalize("NFKC", fields["name"]), fields["description"], "\n".join(lines[end + 1:])


def _script_instructions(name: str, description: str, body: str, record: SkillRecord, scope: str) -> bytes:
    metadata = yaml.safe_dump({"name": name, "description": description}, sort_keys=False, allow_unicode=True)
    return (
        f"---\n{metadata}---\n\n"
        "## AIOPC 项目沙箱\n\n"
        f"脚本只可用 `run_skill_script` 在项目沙箱内执行。技能 ID 为 `{record.id}`，作用域为 `{scope}`。"
        "入口路径使用原技能包内的相对路径，例如 `scripts/` 下的脚本。\n\n"
        "以下说明来自上游。涉及脚本的命令使用上述工具，禁止在本机 Shell 或解释器中执行，也不要把脚本复制到项目。\n\n"
        f"## 上游说明\n\n{body}"
    ).encode()


def _check_script_install(directory: Path, expected: bytes) -> None:
    if directory.is_symlink() or not directory.is_dir() or {path.name for path in directory.iterdir()} != {"SKILL.md"}:
        raise ValueError("已安装的脚本技能目录与采纳记录不符")
    stub = directory / "SKILL.md"
    info = stub.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o111 or stub.read_bytes() != expected:
        raise ValueError("已安装的 SKILL.md 校验不通过")


def _entry(record: SkillRecord, instructions: bytes | None = None) -> dict:
    result = {"id": record.id, "repository": record.repository, "commit": record.commit,
              "source_path": record.source_path, "hash": record.content_hash, "has_scripts": record.has_scripts}
    if instructions is not None:
        result["installed_hash"] = hashlib.sha256(instructions).hexdigest()
    return result


def _install(record: SkillRecord, source: Path, root: Path, scope: str) -> dict:
    config = root / ".opencode"
    _directory(config)
    mutex = config / ".skillhub-adopt.lock"
    lock_file = config / "skills-lock.json"
    _lock_path(mutex)
    try:
        with FileLock(mutex, timeout=30, mode=0o600):
            lock = _read_lock(lock_file)
            skills = config / "skills"
            _directory(skills)
            with tempfile.TemporaryDirectory(dir=config, prefix=".skillhub-adopt-") as temporary:
                staged = Path(temporary) / "skill"
                if record.has_scripts:
                    name, description, body = _skill_source(source, record)
                    instructions = _script_instructions(name, description, body, record, scope)
                    staged.mkdir(mode=0o700)
                    (staged / "SKILL.md").write_bytes(instructions)
                else:
                    shutil.copytree(source, staged, symlinks=True, copy_function=shutil.copyfile)
                    _check_hash(staged, record)
                    _check_scripts(staged)
                    name, _, _ = _skill_source(staged, record)
                    instructions = None
                destination = skills / name
                current = lock["skills"].get(name)
                entry = _entry(record, instructions)
                if current is not None and any(current.get(key) != value for key, value in entry.items()):
                    raise ValueError(f"已有同名技能：{name}")
                result = {**entry, "name": name, "scope": scope, "path": str(destination), "installed": False}
                if destination.exists() or destination.is_symlink():
                    if current is None:
                        raise ValueError(f"已有同名技能：{name}")
                    if instructions is None:
                        _check_hash(destination, record)
                        _check_scripts(destination)
                    else:
                        _check_script_install(destination, instructions)
                    return result

                # Persist the lock first. If the process is interrupted, a
                # retry with the same verified snapshot finishes the install.
                if current is None:
                    updated = {**lock, "skills": {**lock["skills"], name: entry}}
                    _write_lock(lock_file, updated)
                try:
                    staged.rename(destination)
                except OSError:
                    if current is None:
                        _write_lock(lock_file, lock)
                    raise
                return {**result, "installed": True}
    except LockTimeout as exc:
        raise ValueError("技能目录正在更新，请重试") from exc


def verify_mirror(record: SkillRecord, source: Path) -> None:
    """Verify an audited snapshot before a trusted installer uses its payload."""
    if record.specification.status != "passed":
        raise ValueError(f"Agent Skills 规范校验：{record.specification.status}")
    if record.scan.status != "passed":
        raise ValueError(f"Cisco 扫描：{record.scan.status}")
    if not re.fullmatch(r"[0-9a-f]{64}", record.content_hash):
        raise ValueError("技能 hash 无效")
    _check_hash(source, record)


def adopt_skill(
    record: SkillRecord,
    source: Path,
    *,
    company: Path,
    project: Path | None,
    scope: Literal["project", "company"] = "project",
    can_adopt_company: bool = False,
) -> dict:
    """Adopt a catalog record for a trusted session or desktop caller."""
    root = _target(company, project, scope, can_adopt_company=can_adopt_company)
    try:
        verify_mirror(record, source)
        if not record.has_scripts:
            _check_scripts(source)
        return _install(record, source, root, scope)
    except OSError as exc:
        raise ValueError("技能文件无法读取或安装") from exc


def resolve_adopted_script(
    library: Path,
    id: str,
    *,
    company: Path,
    project: Path | None,
    scope: Literal["project", "company"] = "project",
    can_access_company: bool = False,
) -> tuple[SkillRecord, Path]:
    """Read a verified script bundle for a trusted execution caller."""
    company_root = _company_root(company)
    project_root = _project_root(company, company_root, project) if project is not None else None
    if scope == "company" and can_access_company:
        target = company_root
    elif scope == "project" and project_root is not None:
        target = project_root
    else:
        raise ValueError("当前会话无权使用此范围的脚本技能")

    config = target / ".opencode"
    skills = config / "skills"
    if config.is_symlink() or skills.is_symlink():
        raise ValueError("技能目录不能使用符号链接")
    try:
        lock = _read_lock(config / "skills-lock.json")
        if not any(entry.get("id") == id and entry.get("has_scripts") is True for entry in lock["skills"].values()):
            raise ValueError("指定的技能尚未采纳到此范围")
        record = read_skills(library).get(id)
        if record is None or record.id != id or record.has_scripts is not True:
            raise ValueError("技能镜像中找不到锁定的脚本包")
        source = skill_content(library, record)
        verify_mirror(record, source)
        name, description, body = _skill_source(source, record)
        instructions = _script_instructions(name, description, body, record, scope)
        current = lock["skills"].get(name, {})
        if any(current.get(key) != value for key, value in _entry(record, instructions).items()):
            raise ValueError("skills-lock.json 与技能快照或已安装文本不一致")
        _check_script_install(skills / name, instructions)
        return record, source
    except OSError as exc:
        raise ValueError("已采纳的脚本技能无法读取") from exc
