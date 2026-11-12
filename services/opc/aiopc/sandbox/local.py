"""The local environment: one Docker container per project, on this Mac.

This is the baseline every person gets without paying anyone. AIOPC builds its
image once (neko's Chromium desktop plus Chinese fonts, the Chrome Web Store and
a DevTools port), then keeps one container per project with its own volume, so a
project's logins stay in that project and nowhere else. The person never runs a
command; if no container engine is installed, AIOPC says so and offers to
install one.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import socket
from pathlib import Path
from typing import Any

import httpx

from .environment import Environment, ProjectKey, Provider, ProviderInfo, SandboxError

IMAGE = "aiopc/sandbox:1"
IMAGE_DIR = Path(__file__).resolve().parent / "image"
COOKIE_POLICY_FILE = IMAGE_DIR / "aiopc-cookie-persistence.json"
COOKIE_POLICY_DEST = f"/etc/chromium/policies/managed/{COOKIE_POLICY_FILE.name}"
# Chromium's Linux policy loader waits five seconds for file changes to settle.
COOKIE_POLICY_REFRESH_SECONDS = 6
PREFIX = "aiopc-"
SCREEN = "1440x900@30"
# OrbStack and Docker Desktop both install here; neither puts docker on a service's PATH.
DOCKER_CANDIDATES = ("/usr/local/bin/docker", "/opt/homebrew/bin/docker", str(Path.home() / ".orbstack/bin/docker"),
                     "/Applications/Docker.app/Contents/Resources/bin/docker")


def find_docker() -> str | None:
    return shutil.which("docker") or next((path for path in DOCKER_CANDIDATES if Path(path).is_file()), None)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


async def _docker(*args: str, timeout: float = 60, check: bool = True) -> str:
    docker = find_docker()
    if docker is None:
        raise SandboxError("这台电脑上还没有容器引擎。AIOPC 需要它来运行本地沙箱。")
    process = await asyncio.create_subprocess_exec(docker, *args, stdout=asyncio.subprocess.PIPE,
                                                   stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(process.communicate(), timeout)
    except TimeoutError:
        process.kill()
        raise SandboxError(f"容器命令超时：docker {' '.join(args[:2])}") from None
    if check and process.returncode:
        raise SandboxError(f"容器命令失败：{err.decode(errors='replace').strip()[-300:]}")
    return out.decode(errors="replace").strip()


class LocalDockerProvider(Provider):
    info = ProviderInfo(
        id="local",
        name="本机沙箱",
        kind="local",
        summary="在这台电脑上为项目跑一台独立的 Linux 浏览器，免费、数据不出本机。需要容器引擎（OrbStack 或 Docker Desktop）。",
        help_url="https://orbstack.dev/",
    )

    def __init__(self, home: Path):
        self.home = Path(home)
        self._lock = asyncio.Lock()
        self._built = False

    # ── what the person's machine can do ────────────────────────────────
    async def available(self) -> tuple[bool, str]:
        if find_docker() is None:
            return False, "没有找到容器引擎"
        try:
            await _docker("info", "--format", "{{.ServerVersion}}", timeout=20)
        except SandboxError:
            return False, "容器引擎没有在运行"
        return True, ""

    # ── naming ──────────────────────────────────────────────────────────
    @staticmethod
    def container(key: ProjectKey) -> str:
        return f"{PREFIX}{key.slug}"

    @staticmethod
    def volume(key: ProjectKey) -> str:
        return f"{PREFIX}{key.slug}-profile"

    # ── the image ───────────────────────────────────────────────────────
    async def _image_ready(self) -> None:
        if self._built:
            return
        found = await _docker("images", "-q", IMAGE, timeout=30)
        if not found:
            await _docker("build", "-t", IMAGE, str(IMAGE_DIR), timeout=1800)
        self._built = True

    # ── the container ───────────────────────────────────────────────────
    async def _inspect(self, name: str) -> dict[str, Any] | None:
        out = await _docker("inspect", name, check=False, timeout=20)
        try:
            return json.loads(out)[0]
        except (ValueError, IndexError, KeyError):
            return None

    @staticmethod
    def _owned_id(key: ProjectKey, info: dict[str, Any]) -> str:
        labels = (info.get("Config") or {}).get("Labels") or {}
        container_id = info.get("Id")
        if not container_id or labels.get("aiopc.slug") != key.slug:
            raise SandboxError("容器与当前环境不匹配")
        return str(container_id)

    @staticmethod
    async def _install_cookie_policy(container_id: str, state: dict[str, Any], *, running: bool) -> None:
        if state.get("cookiePolicyContainer") == container_id:
            return
        # A cached image and containers created by earlier versions need this
        # drop-in too. Copy into the container without editing its profile.
        await _docker("cp", str(COOKIE_POLICY_FILE), f"{container_id}:{COOKIE_POLICY_DEST}", timeout=20)
        if running:
            await asyncio.sleep(COOKIE_POLICY_REFRESH_SECONDS)
        state["cookiePolicyContainer"] = container_id

    @staticmethod
    def _published(info: dict[str, Any], port: str) -> int:
        bindings = ((info.get("NetworkSettings") or {}).get("Ports") or {}).get(port) or []
        return int(bindings[0]["HostPort"]) if bindings else 0

    async def _environment(self, key: ProjectKey, state: dict[str, Any], info: dict[str, Any] | None) -> Environment:
        if info is None:
            return Environment(provider=self.info.id, status="missing")
        running = bool((info.get("State") or {}).get("Running"))
        if not running:
            return Environment(provider=self.info.id, status="stopped", id=str(state.get("container") or self.container(key)))
        view_port, cdp_port = self._published(info, "8080/tcp"), self._published(info, "9223/tcp")
        password = str(state.get("password") or "")
        return Environment(
            provider=self.info.id, status="running", id=str(state.get("container") or self.container(key)),
            cdp_url=f"http://127.0.0.1:{cdp_port}" if cdp_port else "",
            live_view_url=(f"http://127.0.0.1:{view_port}/?usr=aiopc&pwd={password}&embed=1&cast=0"
                           if view_port and password else ""),
            detail="本机沙箱")

    async def _wait_ready(self, environment: Environment, seconds: float = 90) -> None:
        """Chromium's DevTools answering is what makes the environment usable."""
        deadline = asyncio.get_running_loop().time() + seconds
        async with httpx.AsyncClient(timeout=3, trust_env=False) as client:
            while asyncio.get_running_loop().time() < deadline:
                try:
                    if (await client.get(f"{environment.cdp_url}/json/version")).status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(1)
        raise SandboxError("沙箱里的浏览器没有按时启动")

    async def ensure(self, key: ProjectKey, state: dict[str, Any]) -> Environment:
        async with self._lock:
            ok, why = await self.available()
            if not ok:
                raise SandboxError(f"{why}。请先安装并启动 OrbStack 或 Docker Desktop。")
            name = str(state.get("container") or self.container(key))
            info = await self._inspect(name)
            created_id = None
            running = bool(info and (info.get("State") or {}).get("Running"))
            if info is None:
                await self._image_ready()
                state["password"] = state.get("password") or secrets.token_urlsafe(12)
                # One port for the picture, one for DevTools, one muxed port for the stream itself.
                view_port, cdp_port, media_port = _free_port(), _free_port(), _free_port()
                created_id = await _docker(
                    "create", "--name", name, "--restart", "unless-stopped", "--shm-size=2g",
                    "-l", "aiopc.project=" + key.path, "-l", "aiopc.slug=" + key.slug,
                    "-p", f"127.0.0.1:{view_port}:8080", "-p", f"127.0.0.1:{cdp_port}:9223",
                    "-p", f"127.0.0.1:{media_port}:{media_port}/tcp", "-p", f"127.0.0.1:{media_port}:{media_port}/udp",
                    "-e", f"NEKO_DESKTOP_SCREEN={SCREEN}",
                    "-e", f"NEKO_MEMBER_MULTIUSER_USER_PASSWORD={state['password']}",
                    "-e", f"NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD={state['password']}",
                    "-e", f"NEKO_WEBRTC_TCPMUX={media_port}", "-e", f"NEKO_WEBRTC_UDPMUX={media_port}",
                    "-e", "NEKO_WEBRTC_ICELITE=1", "-e", "NEKO_WEBRTC_NAT1TO1=127.0.0.1",
                    "-v", f"{state.get('volume') or self.volume(key)}:/home/neko/.config/chromium",
                    IMAGE, timeout=180)
                container_id = created_id
            else:
                container_id = self._owned_id(key, info)
            try:
                await self._install_cookie_policy(container_id, state, running=running)
                if not running:
                    await _docker("start", container_id, timeout=120)
                    info = await self._inspect(name)
            except (SandboxError, asyncio.CancelledError):
                if created_id:
                    await _docker("rm", "-f", created_id, check=False, timeout=60)
                raise
            environment = await self._environment(key, state, info)
            if not environment.cdp_url:
                raise SandboxError("沙箱启动了，但没有拿到浏览器的调试端口")
            await self._wait_ready(environment)
            state["container"] = name
            state.setdefault("volume", self.volume(key))
            return environment

    async def status(self, key: ProjectKey, state: dict[str, Any]) -> Environment:
        if find_docker() is None:
            return Environment(provider=self.info.id, status="missing", detail="没有容器引擎")
        return await self._environment(key, state, await self._inspect(str(state.get("container") or self.container(key))))

    async def stop(self, key: ProjectKey, state: dict[str, Any]) -> None:
        name = str(state.get("container") or self.container(key))
        info = await self._inspect(name)
        if info and (info.get("State") or {}).get("Running"):
            container_id = self._owned_id(key, info)
            await self._install_cookie_policy(container_id, state, running=True)
            name = container_id
        await _docker("stop", name, check=False, timeout=120)

    async def destroy(self, key: ProjectKey, state: dict[str, Any]) -> None:
        """Remove the container and, with it, every login kept in its profile."""
        await _docker("rm", "-f", str(state.get("container") or self.container(key)), check=False, timeout=120)
        await _docker("volume", "rm", str(state.get("volume") or self.volume(key)), check=False, timeout=60)
        state.pop("container", None)

    async def reset(self, key: ProjectKey, state: dict[str, Any]) -> None:
        # Listing with checked commands distinguishes "already absent" from an
        # unavailable daemon. Failed deletion must never transfer an old profile.
        name = str(state.get("container") or self.container(key))
        volume = str(state.get("volume") or self.volume(key))
        containers = (await _docker("ps", "-a", "--format", "{{.Names}}", timeout=30)).splitlines()
        if name in containers:
            await _docker("rm", "-f", name, timeout=120)
        volumes = (await _docker("volume", "ls", "--format", "{{.Name}}", timeout=30)).splitlines()
        if volume in volumes:
            await _docker("volume", "rm", volume, timeout=60)
        state.clear()


INSTALLERS = {
    # OrbStack (free for personal use) starts faster and uses less memory than Docker Desktop on a Mac.
    "orbstack": {"name": "OrbStack", "brew": "orbstack", "url": "https://orbstack.dev/download"},
}


async def install_engine(name: str = "orbstack") -> dict[str, Any]:
    """Install a container engine with Homebrew when it is there, so the person runs nothing."""
    choice = INSTALLERS.get(name)
    if choice is None:
        raise SandboxError(f"不认识的容器引擎：{name}")
    brew = shutil.which("brew") or next((path for path in ("/opt/homebrew/bin/brew", "/usr/local/bin/brew")
                                         if Path(path).is_file()), None)
    if brew is None:
        return {"installed": False, "url": choice["url"],
                "message": f"这台电脑没有 Homebrew，无法自动安装。请从官网下载 {choice['name']} 后再回来。"}
    process = await asyncio.create_subprocess_exec(brew, "install", "--cask", choice["brew"],
                                                   stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                                                   env={**os.environ, "NONINTERACTIVE": "1"})
    out, _ = await process.communicate()
    if process.returncode:
        return {"installed": False, "url": choice["url"],
                "message": f"自动安装 {choice['name']} 没有成功：{out.decode(errors='replace').strip()[-300:]}"}
    return {"installed": True, "message": f"{choice['name']} 已安装。正在启动容器引擎……"}
