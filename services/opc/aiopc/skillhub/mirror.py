"""Build a pinned local mirror and the Markdown view consumed by qmd."""

from __future__ import annotations

import json
import os
import tempfile
from collections import Counter, defaultdict
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from typing import Protocol
from urllib.parse import quote

from filelock import FileLock

from .audit import AuditResult, validate_skill
from .catalog import CatalogEntry, load_catalog
from .manifest import SkillRecord, atomic_text, hash_skill, read_manifest, skill_content, skill_id, write_manifest
from .upstream import GitRepository, GitSnapshot, UpstreamError
from .view import render_index

_PINS = "skills-pins.json"
_SUPPORTED = {"skill", "repository", "tree"}
_BATCH_SIZE = 48


class Scanner(Protocol):
    def scan_many(self, directories: list[Path]) -> dict[Path, AuditResult]: ...


@dataclass
class _RepositoryResult:
    pins: dict[str, str]
    records: dict[str, SkillRecord]
    coverage: dict[str, dict]


def _coverage(entry: CatalogEntry, status: str, *, detail: str | None = None) -> dict:
    outcome = {"kind": entry.kind, "status": status, "categories": entry.categories}
    if entry.repository:
        outcome["repository"] = entry.repository
        outcome["ref"] = entry.ref
        outcome["source_path"] = entry.path
    if detail:
        outcome["detail"] = detail
    return outcome


def _merge_labels(entries: list[CatalogEntry], field: str) -> dict[str, tuple[str, ...]]:
    grouped = defaultdict(list)
    for entry in entries:
        for language, values in getattr(entry, field).items():
            grouped[language].extend(values)
    return {language: tuple(dict.fromkeys(values)) for language, values in grouped.items()}


def _process_batch(
    repository: str, snapshot: GitSnapshot, paths: list[str], sources: dict[tuple[str, str], list[CatalogEntry]],
    root: Path, index: Path, scanner: Scanner, records: dict[str, SkillRecord], coverage: dict[str, dict],
) -> None:
    with tempfile.TemporaryDirectory(dir=root / "skills-mirror", prefix=".staging-") as work:
        pending: dict[Path, tuple[SkillRecord, str]] = {}
        for source_path in paths:
            entries = sources[snapshot.commit, source_path]
            direct = [entry for entry in entries if entry.kind == "skill"]
            label_entries = direct or entries
            identifier = skill_id(repository, source_path, snapshot.commit)
            directory = Path(work) / identifier
            try:
                has_scripts = snapshot.copy_skill(source_path, directory)
                source = (directory / "SKILL.md").read_text(encoding="utf-8")
                name = PurePosixPath(source_path).parent.name or repository.split("/")[1]
                frontmatter, specification = validate_skill(source, name)
                title = frontmatter.get("name")
                license_name = frontmatter.get("license")
                record = SkillRecord(
                    id=identifier, repository=repository, commit=snapshot.commit, source_path=source_path,
                    source_url=f"https://github.com/{repository}/blob/{snapshot.commit}/{quote(source_path)}",
                    license=license_name if isinstance(license_name, str) else snapshot.license_for(source_path),
                    categories=tuple(sorted({category for entry in entries for category in entry.categories})),
                    names=_merge_labels(label_entries, "names"), descriptions=_merge_labels(label_entries, "descriptions"),
                    has_scripts=has_scripts, content_hash=hash_skill(directory), specification=specification,
                    scan=AuditResult("skipped", ()), title=title if isinstance(title, str) and title else name,
                )
            except (UpstreamError, UnicodeError, ValueError, OSError) as exc:
                for entry in entries:
                    coverage[entry.url].setdefault("errors", {})[source_path] = str(exc)
                continue
            pending[directory] = (record, source)

        audits = scanner.scan_many(list(pending)) if pending else {}
        for directory, (record, source) in pending.items():
            scan = audits.get(directory, AuditResult("unreachable", ("扫描器缺少该技能的结果",)))
            record = replace(record, scan=scan)
            target = skill_content(root, record)
            target.parent.mkdir(mode=0o700, exist_ok=True)
            if target.exists():
                if hash_skill(target) != record.content_hash:
                    raise ValueError(f"技能镜像 hash 不一致：{record.id}")
            else:
                directory.rename(target)
            (index / f"{record.id}.md").write_text(render_index(record, source), encoding="utf-8")
            records[record.id] = record
            for entry in sources[snapshot.commit, record.source_path]:
                coverage[entry.url].setdefault("skills", []).append(record.id)


def _process_repository(
    repository: str, entries: list[CatalogEntry], pinned: dict[str, str], scratch: Path,
    root: Path, index: Path, scanner: Scanner,
) -> _RepositoryResult:
    pins, records = dict(pinned), {}
    coverage = {entry.url: _coverage(entry, "missing") for entry in entries}
    with tempfile.TemporaryDirectory(dir=scratch, prefix="upstream-") as workspace:
        try:
            repo = GitRepository.clone(repository, Path(workspace) / "repo")
        except UpstreamError as exc:
            return _RepositoryResult(pins, records, {entry.url: _coverage(entry, exc.reason, detail=str(exc)) for entry in entries})

        refs: dict[str, GitSnapshot | UpstreamError] = {}
        snapshots: dict[str, GitSnapshot] = {}
        paths_by_commit: dict[str, tuple[str, ...]] = {}
        sources = defaultdict(list)
        for entry in entries:
            ref = entry.ref or "HEAD"
            requested = pinned.get(ref, ref)
            if requested not in refs:
                try:
                    refs[requested] = repo.snapshot(requested)
                except UpstreamError as exc:
                    refs[requested] = exc
            snapshot = refs[requested]
            if isinstance(snapshot, UpstreamError):
                coverage[entry.url] = _coverage(entry, snapshot.reason, detail=str(snapshot))
                continue
            pins[ref] = snapshot.commit
            snapshots[snapshot.commit] = snapshot
            if snapshot.commit not in paths_by_commit:
                paths_by_commit[snapshot.commit] = snapshot.skill_paths()
            all_paths = paths_by_commit[snapshot.commit]
            if entry.kind == "skill":
                paths = (entry.path,) if entry.path in all_paths else ()
            elif entry.kind == "tree" and entry.path:
                prefix = entry.path.rstrip("/") + "/"
                paths = tuple(path for path in all_paths if path.startswith(prefix))
            else:
                paths = all_paths
            if not paths:
                coverage[entry.url]["detail"] = "固定提交中没有对应的 SKILL.md"
            coverage[entry.url]["commit"] = snapshot.commit
            for path in paths:
                sources[snapshot.commit, path].append(entry)

        by_commit = defaultdict(list)
        for commit, path in sources:
            by_commit[commit].append(path)
        for commit, paths in by_commit.items():
            for offset in range(0, len(paths), _BATCH_SIZE):
                _process_batch(repository, snapshots[commit], paths[offset:offset + _BATCH_SIZE], sources, root, index, scanner, records, coverage)

    for outcome in coverage.values():
        if outcome.get("skills"):
            outcome["status"] = "partial" if outcome.get("errors") else "mirrored"
        elif outcome.get("errors"):
            outcome["status"] = "failed"
    return _RepositoryResult(pins, records, coverage)


def build_mirror(
    catalog: Path, library: Path, scratch: Path, scanner: Scanner, *, jobs: int = 6,
    repositories: set[str] | None = None, progress: Callable[[str], None] | None = None,
) -> dict:
    if jobs < 1 or jobs > 16:
        raise ValueError("并行仓库数必须在 1 至 16 之间")
    entries = load_catalog(catalog)
    if repositories is not None:
        entries = [entry for entry in entries if entry.repository in repositories]
        if {entry.repository for entry in entries} != repositories:
            raise ValueError("指定的仓库不在目录中")
    grouped = defaultdict(list)
    coverage = {}
    for entry in entries:
        if entry.repository and entry.kind in _SUPPORTED:
            grouped[entry.repository].append(entry)
        else:
            coverage[entry.url] = _coverage(entry, "manual" if entry.kind == "external" else "reference")

    root = library.resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with FileLock(root / ".skills-build.lock", timeout=0):
        previous = read_manifest(root)
        if repositories is not None and set(previous["catalog"]) - {entry.url for entry in entries}:
            raise ValueError("样本镜像需要单独的目录，不能覆盖完整技能库")
        return _build(root, scratch, scanner, grouped, coverage, jobs, progress, previous)


def _retain_unreachable(root: Path, previous: dict, records: dict[str, SkillRecord], coverage: dict[str, dict]) -> None:
    for url, outcome in coverage.items():
        if outcome["status"] != "unreachable":
            continue
        retained = []
        old_outcome = previous["catalog"].get(url, {})
        for identifier in old_outcome.get("skills", []):
            if identifier not in previous["skills"]:
                continue
            record = SkillRecord.from_dict(previous["skills"][identifier])
            if record.repository != outcome["repository"] or record.id != identifier:
                continue
            if not skill_content(root, record).is_dir() or not (root / "skills-index" / f"{identifier}.md").is_file():
                continue
            records.setdefault(identifier, record)
            retained.append(identifier)
        if retained:
            outcome["skills"] = retained
            outcome["using_previous_snapshot"] = True


def _build(root, scratch, scanner, grouped, coverage, jobs, progress, previous):
    for directory in (root / "skills-mirror", root / "skills-index"):
        if directory.is_symlink():
            raise ValueError(f"镜像目录不能使用符号链接：{directory}")
        directory.mkdir(mode=0o700, exist_ok=True)
    pin_path = root / _PINS
    pins = json.loads(pin_path.read_text(encoding="utf-8")) if pin_path.exists() else {}
    records = {}
    with tempfile.TemporaryDirectory(dir=root, prefix=".skills-index-") as staging:
        index = Path(staging)
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            futures = {
                pool.submit(_process_repository, repo, entries, pins.get(repo, {}), scratch, root, index, scanner): repo
                for repo, entries in grouped.items()
            }
            for future in as_completed(futures):
                repo = futures[future]
                result = future.result()
                pins[repo] = result.pins
                records.update(result.records)
                coverage.update(result.coverage)
                atomic_text(pin_path, json.dumps(pins, sort_keys=True) + "\n")
                if progress:
                    progress(f"{repo}: {len(result.records)} skills")
        _retain_unreachable(root, previous, records, coverage)
        target_index = root / "skills-index"
        for path in index.iterdir():
            os.replace(path, target_index / path.name)
        write_manifest(root, records, {repo: pins[repo] for repo in grouped}, coverage)
        for path in target_index.glob("*.md"):
            if path.stem not in records:
                path.unlink()
    return {
        "repositories": len(grouped), "skills": len(records), "with_scripts": sum(record.has_scripts for record in records.values()),
        "catalog": dict(Counter(entry["status"] for entry in coverage.values())),
        "specification": dict(Counter(record.specification.status for record in records.values())),
        "scan": dict(Counter(record.scan.status for record in records.values())),
    }
