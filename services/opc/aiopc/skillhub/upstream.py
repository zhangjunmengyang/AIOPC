"""Fetch public GitHub snapshots and copy tracked skill files without checking out upstream code."""

import os
import re
import shutil
import subprocess
import unicodedata
from bisect import bisect_left
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Literal

from .catalog import canonical_repository

_COMMIT = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z", re.IGNORECASE)
_LICENSE = re.compile(r"(?:licen[cs]e|copying)(?:\.[a-z0-9]+)?\Z", re.IGNORECASE)
_SPDX = re.compile(r"^\s*SPDX-License-Identifier:\s*(.+)\s*$", re.MULTILINE)
_SCRIPT_EXTENSIONS = frozenset({
    ".app", ".apk", ".bat", ".bash", ".bin", ".cjs", ".class", ".cmd", ".com", ".command", ".dll", ".dylib", ".exe", ".fish", ".jar",
    ".js", ".jsx", ".lua", ".mjs", ".php", ".pl", ".ps1", ".py", ".pyc", ".pyw", ".r", ".rb", ".sh", ".so",
    ".swift", ".ts", ".tsx", ".vbs", ".wasm", ".zsh",
})
_EXECUTABLE_MAGIC = (
    b"#!", b"\x7fELF", b"MZ", b"\x00asm", b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
)
_FILE_MODES = {b"100644", b"100755"}
_GIT = ["git", "--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]
_GIT_ENV = {
    **{name: os.environ[name] for name in ("PATH", "TMPDIR") if name in os.environ},
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_ALLOW_PROTOCOL": "https",
    "LC_ALL": "C",
}


class UpstreamError(Exception):
    def __init__(self, reason: Literal["unreachable", "missing", "unsafe", "failed"], message: str):
        super().__init__(message)
        self.reason = reason


def is_script(relative: str, header: bytes, *, executable: bool = False) -> bool:
    path = PurePosixPath(relative.lower())
    return (
        executable
        or "scripts" in path.parts[:-1]
        or path.suffix in _SCRIPT_EXTENSIONS
        or header.startswith(_EXECUTABLE_MAGIC)
    )


def _git(*args: str, cwd: Path, timeout: float) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run([*_GIT, *args], cwd=cwd, env=_GIT_ENV, capture_output=True, timeout=timeout, check=False)


def _detail(result: subprocess.CompletedProcess[bytes]) -> str:
    return result.stderr.decode("utf-8", errors="replace").strip()[-500:]


class GitRepository:
    def __init__(self, directory: Path, *, timeout: float = 180):
        self.directory = directory
        self.timeout = timeout
        self._refs: dict[str, GitSnapshot] = {}
        self._commits: dict[str, GitSnapshot] = {}

    @classmethod
    def clone(cls, repository: str, destination: Path, *, timeout: float = 180) -> "GitRepository":
        canonical = canonical_repository(repository)
        if canonical is None:
            raise UpstreamError("unsafe", f"Invalid GitHub repository: {repository}")
        if destination.is_symlink() or (destination.exists() and (not destination.is_dir() or any(destination.iterdir()))):
            raise UpstreamError("unsafe", f"Expected a fresh clone directory: {destination}")
        try:
            result = _git(
                "clone", "--depth=1", "--single-branch", "--no-tags", "--no-checkout", "--no-recurse-submodules", "--template=", "--",
                f"https://github.com/{canonical}.git", str(destination.absolute()), cwd=destination.parent, timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise UpstreamError("unreachable", f"Timed out fetching {canonical}") from exc
        except OSError as exc:
            raise UpstreamError("failed", f"Could not run Git for {canonical}: {exc}") from exc
        if result.returncode:
            raise UpstreamError("unreachable", f"Could not clone {canonical}: {_detail(result)}")
        return cls(destination, timeout=timeout)

    def _run(self, *args: str) -> subprocess.CompletedProcess[bytes]:
        try:
            return _git(*args, cwd=self.directory, timeout=self.timeout)
        except subprocess.TimeoutExpired as exc:
            reason = "unreachable" if args[0] == "fetch" else "failed"
            raise UpstreamError(reason, f"Git {args[0]} timed out") from exc
        except OSError as exc:
            raise UpstreamError("failed", f"Could not run Git {args[0]}: {exc}") from exc

    def _resolve(self, ref: str) -> str:
        pinned = _COMMIT.fullmatch(ref) is not None
        if ref.startswith("-") or (not pinned and self._run("check-ref-format", "--allow-onelevel", ref).returncode):
            raise UpstreamError("unsafe", f"Invalid Git ref: {ref}")
        local = ref if ref == "HEAD" or pinned else f"refs/remotes/origin/{ref}"
        result = self._run("rev-parse", "--verify", f"{local}^{{commit}}")
        if result.returncode and ref != "HEAD":
            fetched = self._run("fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", "origin", ref)
            if fetched.returncode:
                detail = _detail(fetched)
                reason = "missing" if "couldn't find remote ref" in detail or "not our ref" in detail else "unreachable"
                raise UpstreamError(reason, f"Could not fetch Git ref {ref}: {detail}")
            result = self._run("rev-parse", "--verify", "FETCH_HEAD^{commit}")
        commit = result.stdout.decode("ascii", errors="replace").strip()
        if result.returncode or not _COMMIT.fullmatch(commit) or (pinned and commit.lower() != ref.lower()):
            raise UpstreamError("missing", f"Git ref does not resolve to a commit: {ref}")
        return commit

    def snapshot(self, ref: str | None) -> "GitSnapshot":
        ref = ref or "HEAD"
        if ref not in self._refs:
            commit = self._resolve(ref)
            if commit not in self._commits:
                self._commits[commit] = GitSnapshot(self, commit)
            self._refs[ref] = self._commits[commit]
        return self._refs[ref]


@dataclass(frozen=True)
class _GitObject:
    mode: bytes
    id: bytes


def _safe_components(relative: str) -> tuple[str, ...]:
    components = tuple(relative.split("/"))
    for name in components:
        normalized = unicodedata.normalize("NFC", name).casefold()
        if (
            normalized in {"", ".", "..", ".git", "git~1"}
            or name.endswith((".", " "))
            or "\\" in name
            or ":" in name
            or any(unicodedata.category(character) in {"Cc", "Cs"} for character in name)
        ):
            raise UpstreamError("unsafe", f"Unsafe Git tree path: {relative!r}")
    return components


class GitSnapshot:
    def __init__(self, repository: GitRepository, commit: str):
        self.commit = commit
        self._repository = repository
        result = repository._run("ls-tree", "-r", "-z", "--full-tree", commit)
        if result.returncode:
            raise UpstreamError("failed", f"Could not read tree for {commit}: {_detail(result)}")
        self._files = {}
        for record in result.stdout.split(b"\0"):
            if record:
                metadata, path = record.split(b"\t", 1)
                mode, _, object_id = metadata.split(b" ")
                self._files[path.decode("utf-8", errors="surrogateescape")] = _GitObject(mode, object_id)
        self._paths = tuple(sorted(self._files))
        self._skills = tuple(path for path in self._paths if path.rsplit("/", 1)[-1] == "SKILL.md")
        self._skill_roots = {path.rpartition("/")[0] for path in self._skills}
        self._licenses: dict[str, str] = {}
        self._license_labels: dict[str, str] = {}
        for path in self._paths:
            parent, _, name = path.rpartition("/")
            if self._files[path].mode in _FILE_MODES and _LICENSE.fullmatch(name):
                self._licenses.setdefault(parent, path)

    def skill_paths(self, prefix: str | None = None) -> tuple[str, ...]:
        if prefix is None:
            return self._skills
        return tuple(path for path in self._skills if path.startswith(f"{prefix}/"))

    def license_for(self, skill_path: str) -> str | None:
        parent = PurePosixPath(skill_path).parent
        for directory in (parent, *parent.parents):
            license_path = self._licenses.get("" if directory == PurePosixPath(".") else str(directory))
            if license_path is not None:
                if license_path not in self._license_labels:
                    self._license_labels[license_path] = self._license_label(license_path)
                return self._license_labels[license_path]
        return None

    def _license_label(self, path: str) -> str:
        object_id = self._files[path].id.decode("ascii")
        size = self._repository._run("cat-file", "-s", object_id)
        if size.returncode or not size.stdout.strip().isdigit() or int(size.stdout) > 65_536:
            return path
        result = self._repository._run("cat-file", "blob", object_id)
        if result.returncode:
            return path
        body = result.stdout.decode("utf-8", errors="replace")
        spdx = _SPDX.search(body)
        if spdx:
            return spdx[1].strip()
        body = " ".join(body.lower().split())
        if body.startswith(("mit license ", "the mit license ")) and "permission is hereby granted, free of charge" in body:
            return "MIT"
        if "apache license version 2.0, january 2004" in body:
            return "Apache-2.0"
        return path

    def _skill_files(self, skill_path: str) -> list[tuple[str, _GitObject]]:
        if skill_path not in self._files or skill_path.rsplit("/", 1)[-1] != "SKILL.md":
            raise UpstreamError("missing", f"No tracked SKILL.md at {skill_path!r}")
        _safe_components(skill_path)
        root, separator, _ = skill_path.rpartition("/")
        prefix = root + separator
        matching = []
        seen: dict[tuple[str, ...], tuple[str, ...]] = {}
        for index in range(bisect_left(self._paths, prefix), len(self._paths)):
            path = self._paths[index]
            if not path.startswith(prefix):
                break
            relative = path[len(prefix):]
            # OpenCode recursively discovers SKILL.md. Each nested skill has its own scan and mirror entry.
            if any(str(parent) in self._skill_roots for parent in PurePosixPath(path).parents if str(parent).startswith(prefix)):
                continue
            components = _safe_components(relative)
            for count in range(1, len(components) + 1):
                parts = components[:count]
                normalized = tuple(unicodedata.normalize("NFC", name).casefold() for name in parts)
                if seen.setdefault(normalized, parts) != parts:
                    raise UpstreamError("unsafe", f"Colliding Git tree path: {relative!r}")
            entry = self._files[path]
            if entry.mode not in _FILE_MODES:
                raise UpstreamError("unsafe", f"Git tree path is a symlink, submodule, or non-regular file: {relative!r}")
            matching.append((relative, entry))
        return matching

    def copy_skill(self, skill_path: str, destination: Path) -> bool:
        files = self._skill_files(skill_path)
        try:
            destination.mkdir(mode=0o700)
        except OSError as exc:
            raise UpstreamError("failed", f"Could not create a fresh mirror directory: {destination}") from exc
        try:
            return self._copy_blobs(files, destination)
        except BaseException:
            shutil.rmtree(destination)
            raise

    def _copy_blobs(self, files: list[tuple[str, _GitObject]], destination: Path) -> bool:
        try:
            with subprocess.Popen(
                [*_GIT, "cat-file", "--batch"], cwd=self._repository.directory, env=_GIT_ENV,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            ) as process:
                assert process.stdin is not None and process.stdout is not None
                has_scripts = False
                try:
                    for relative, entry in files:
                        process.stdin.write(entry.id + b"\n")
                        process.stdin.flush()
                        target = destination / relative
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with target.open("xb") as output:
                            header = _copy_blob(process.stdout, output, entry.id)
                        has_scripts |= is_script(relative, header, executable=entry.mode == b"100755")
                    process.stdin.close()
                    if process.wait(timeout=self._repository.timeout):
                        raise UpstreamError("failed", "Git failed while reading skill files")
                finally:
                    if process.poll() is None:
                        process.kill()
                return has_scripts
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise UpstreamError("failed", f"Could not copy Git tree: {exc}") from exc


def _copy_blob(source: BinaryIO, output: BinaryIO, expected: bytes) -> bytes:
    metadata = source.readline(150).split()
    if len(metadata) != 3 or metadata[:2] != [expected, b"blob"] or not metadata[2].isdigit():
        raise UpstreamError("failed", "Git did not return the requested blob")
    remaining = int(metadata[2])
    header = source.read(min(64, remaining))
    output.write(header)
    remaining -= len(header)
    while remaining:
        chunk = source.read(min(remaining, 1_048_576))
        if not chunk:
            raise UpstreamError("failed", "Git blob ended early")
        output.write(chunk)
        remaining -= len(chunk)
    if source.read(1) != b"\n":
        raise UpstreamError("failed", "Git blob had no terminator")
    return header
