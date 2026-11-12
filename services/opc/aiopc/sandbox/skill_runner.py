"""Run a verified skill snapshot in a disposable, offline local container."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import math
import os
import re
import stat
import uuid
from collections.abc import Sequence
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from typing import TypedDict

from . import local
from .environment import SandboxError

_INTERPRETERS = {".py": ("/usr/bin/python3", "-I", "-B"), ".sh": ("/bin/sh",)}
_MAX_BUNDLE_BYTES = 16 * 1024 * 1024
_MAX_BUNDLE_ENTRIES = 1024
_MAX_STREAM_BYTES = 32 * 1024
_IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
_CONTAINER_ID = re.compile(r"[0-9a-f]{64}\Z")


class ScriptResult(TypedDict):
    exit_code: int
    stdout: str
    stderr: str
    truncated: bool


@dataclass(frozen=True)
class _CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""
    truncated: bool = False


async def _read_stream(stream: asyncio.StreamReader) -> tuple[str, bool]:
    kept = bytearray()
    truncated = False
    while chunk := await stream.read(8192):
        remaining = _MAX_STREAM_BYTES - len(kept)
        truncated |= len(chunk) > remaining
        kept.extend(chunk[:remaining])
    return kept.decode("utf-8", errors="replace"), truncated


async def _call(command: tuple[str, ...], *, timeout_s: float) -> _CommandResult:
    environment = {key: os.environ[key] for key in ("HOME", "PATH", "DOCKER_CONFIG", "XDG_RUNTIME_DIR") if key in os.environ}
    process = await asyncio.create_subprocess_exec(*command, env=environment, stdin=asyncio.subprocess.DEVNULL,
                                                   stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    assert process.stdout is not None and process.stderr is not None
    captured = asyncio.gather(_read_stream(process.stdout), _read_stream(process.stderr), process.wait())
    try:
        async with asyncio.timeout(timeout_s):
            stdout, stderr, returncode = await asyncio.shield(captured)
    finally:
        if not captured.done():
            with suppress(ProcessLookupError):
                process.kill()
            await captured
    return _CommandResult(returncode, stdout[0], stderr[0], stdout[1] or stderr[1])


async def _local_command() -> tuple[str, ...]:
    docker = local.find_docker()
    if docker is None:
        raise SandboxError("运行技能脚本需要本机 Docker 容器引擎")
    context = os.environ.get("DOCKER_CONTEXT")
    endpoint = None if context else os.environ.get("DOCKER_HOST")
    if not endpoint:
        command = (docker, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}")
        result = await _call((*command, "--", context) if context else command, timeout_s=10)
        if result.returncode != 0:
            raise SandboxError("无法读取本机 Docker 容器引擎的连接地址")
        endpoint = result.stdout.strip()
    if not endpoint.startswith("unix:///") or not Path(endpoint.removeprefix("unix://")).is_socket():
        raise SandboxError("技能脚本只支持通过本机 Unix socket 连接 Docker")
    return docker, "--host", endpoint


async def _image_id(provider: local.LocalDockerProvider, docker: tuple[str, ...]) -> str:
    async with provider._lock:
        await provider._image_ready()
        image = await _call((*docker, "image", "inspect", "--format", '{{.Id}} {{json (index .Config "Volumes")}}', local.IMAGE),
                            timeout_s=15)
    image_id, _, volumes = image.stdout.strip().partition(" ")
    if image.returncode or not _IMAGE_ID.fullmatch(image_id):
        raise SandboxError("本机缺少可验证的 AIOPC 沙箱镜像")
    if volumes not in {"null", "{}"}:
        raise SandboxError("AIOPC 沙箱镜像声明了隐式挂载，无法隔离运行技能脚本")
    return image_id


def _entry_path(entry: str) -> PurePosixPath:
    if not isinstance(entry, str):
        raise SandboxError("技能入口必须是相对路径")
    path = PurePosixPath(entry)
    if (len(entry) > 512 or "\\" in entry or any(ord(char) < 32 for char in entry)
            or path.as_posix() != entry or len(path.parts) < 2 or path.parts[0] != "scripts"
            or ".." in path.parts or path.suffix not in _INTERPRETERS):
        raise SandboxError("技能入口必须是 scripts/ 目录下的 Python 或 sh 脚本")
    return path


def _stage(bundle: Path, destination: Path, entry: PurePosixPath) -> None:
    if bundle.is_symlink() or not bundle.is_dir() or destination.resolve().is_relative_to(bundle.resolve()):
        raise SandboxError("技能快照目录无效")
    size = count = 0
    errors: list[OSError] = []
    for root, dirs, files, descriptor in os.fwalk(bundle, onerror=errors.append, follow_symlinks=False):
        directory = destination / Path(root).relative_to(bundle)
        directory.mkdir(mode=0o755, exist_ok=True)
        count += len(dirs) + len(files)
        if count > _MAX_BUNDLE_ENTRIES:
            raise SandboxError("技能快照文件过多，超出沙箱运行限制")
        for name in dirs:
            if not stat.S_ISDIR(os.stat(name, dir_fd=descriptor, follow_symlinks=False).st_mode):
                raise SandboxError("技能快照不能包含目录链接")
        for name in files:
            opened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
            with os.fdopen(opened, "rb") as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise SandboxError("技能快照只能包含无链接的普通文件")
                data = source.read(_MAX_BUNDLE_BYTES - size + 1)
            size += len(data)
            if size > _MAX_BUNDLE_BYTES:
                raise SandboxError("技能快照超出沙箱运行大小限制")
            target = directory / name
            target.write_bytes(data)
            target.chmod(0o444)
    if errors or not (destination / entry).is_file():
        raise SandboxError("技能脚本不在可读取的快照中")


def _mount(source: Path) -> str:
    buffer = io.StringIO()
    csv.writer(buffer, lineterminator="\n").writerow(("type=bind", f"source={source}", "target=/skill", "readonly"))
    return buffer.getvalue().removesuffix("\n")


async def _remove_container(docker: tuple[str, ...], container: str) -> None:
    for _ in range(2):
        try:
            result = await _call((*docker, "rm", "--force", "--volumes", container), timeout_s=10)
        except (TimeoutError, OSError):
            continue
        if result.returncode == 0 or "No such container" in result.stderr:
            return
    raise SandboxError(f"无法回收技能执行容器 {container}，请检查本机 Docker")


async def _execute(docker: tuple[str, ...], image_id: str, staged: Path, entry: PurePosixPath, args: Sequence[str],
                   timeout_s: float) -> ScriptResult:
    name = f"aiopc-skill-{uuid.uuid4().hex}"
    container = name
    interpreter, *options = _INTERPRETERS[entry.suffix]
    try:
        created = await _call((
            *docker, "create", "--name", name, "--label", "io.aiopc.skill-run=true", "--pull=never",
            "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges=true",
            "--user=65534:65534", "--pids-limit=64", "--cpus=1", "--memory=256m", "--memory-swap=256m",
            "--ulimit", "nofile=256:256", "--init", "--log-driver=none", "--no-healthcheck",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777", "--env", "HOME=/tmp",
            "--mount", _mount(staged), "--workdir", "/skill", "--entrypoint", interpreter,
            image_id, *options, f"/skill/{entry}", *args,
        ), timeout_s=20)
        candidate = created.stdout.strip()
        if created.returncode != 0 or not _CONTAINER_ID.fullmatch(candidate):
            raise SandboxError("无法创建隔离技能执行容器")
        container = candidate
        try:
            output = await _call((*docker, "start", "--attach", container), timeout_s=timeout_s)
        except TimeoutError:
            raise SandboxError("技能脚本执行超时") from None
        inspected = await _call((*docker, "container", "inspect", "--format", "{{json .State}}", container), timeout_s=10)
        try:
            state = json.loads(inspected.stdout)
            code = state["ExitCode"]
            if inspected.returncode or state.get("Status") != "exited" or state.get("Error") or type(code) is not int:
                raise ValueError
        except (ValueError, KeyError, TypeError, AttributeError):
            raise SandboxError("无法确认技能容器中的脚本执行结果") from None
        return {"exit_code": code, "stdout": output.stdout, "stderr": output.stderr, "truncated": output.truncated}
    finally:
        # The daemon may create the container even if the CLI loses the response.
        cleanup = asyncio.create_task(_remove_container(docker, container))
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            await cleanup
            raise


async def run_skill_script(provider: local.LocalDockerProvider, bundle: Path, entry: str, args: Sequence[str] = (), *,
                           timeout_s: float = 30) -> ScriptResult:
    """The caller authorizes the project and role, and supplies a private, hash-verified snapshot."""
    if not isinstance(provider, local.LocalDockerProvider):
        raise SandboxError("此项目环境不支持隔离运行技能脚本，请选择本机 Docker 环境")
    if not isinstance(timeout_s, (int, float)) or isinstance(timeout_s, bool) or not math.isfinite(timeout_s) or not 0 < timeout_s <= 60:
        raise SandboxError("技能脚本超时必须大于零且不超过 60 秒")
    if (isinstance(args, (str, bytes)) or len(args) > 32
            or any(not isinstance(arg, str) or len(arg) > 4096 or "\0" in arg for arg in args)):
        raise SandboxError("技能脚本参数超出限制")
    path = _entry_path(entry)
    try:
        provider.home.mkdir(mode=0o700, parents=True, exist_ok=True)
        with TemporaryDirectory(prefix=".skill-run-", dir=provider.home) as temporary:
            staged = Path(temporary) / "skill"
            _stage(bundle, staged, path)
            docker = await _local_command()
            image_id = await _image_id(provider, docker)
            return await _execute(docker, image_id, staged, path, tuple(args), timeout_s)
    except OSError:
        raise SandboxError("无法准备技能快照或连接本机 Docker") from None
    except TimeoutError:
        raise SandboxError("本机 Docker 准备技能执行容器超时") from None
