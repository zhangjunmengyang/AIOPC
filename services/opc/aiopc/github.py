"""GitHub for AIOPC through the official GitHub CLI (gh, MIT).

The person never runs a command: AIOPC downloads gh into ~/.aiopc/bin when it is
missing (checked against the release's published checksums), runs gh's own
browser authorization (OAuth device flow) and shows the one-time code in the app.
gh keeps the token in the system keychain; the AI then uses gh for repositories,
issues, pull requests and notifications.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import platform
import re
import shutil
import stat
import zipfile
from pathlib import Path

import httpx

RELEASES = "https://api.github.com/repos/cli/cli/releases/latest"
DEVICE_URL = "https://github.com/login/device"
CODE = re.compile(r"\b([A-Z0-9]{4}-[A-Z0-9]{4})\b")


class GitHubError(ValueError):
    pass


def bin_dir(home: Path) -> Path:
    return Path(home) / "bin"


def find_gh(home: Path | None = None) -> str | None:
    """gh from AIOPC's own bin, PATH, or Homebrew's usual places."""
    candidates = [str(bin_dir(home) / "gh")] if home else []
    candidates += [shutil.which("gh") or "", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]
    return next((path for path in candidates if path and Path(path).is_file() and os.access(path, os.X_OK)), None)


async def install_gh(home: Path) -> str:
    """Download the latest gh release for this Mac into ~/.aiopc/bin, verified against its checksums."""
    arch = "arm64" if platform.machine() in ("arm64", "aarch64") else "amd64"
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        release = (await client.get(RELEASES, headers={"Accept": "application/vnd.github+json"})).json()
        assets = {asset["name"]: asset["browser_download_url"] for asset in release.get("assets", [])}
        archive_name = next((name for name in assets if name.endswith(f"_macOS_{arch}.zip")), None)
        sums_name = next((name for name in assets if name.endswith("_checksums.txt")), None)
        if not archive_name or not sums_name:
            raise GitHubError("没有找到适合这台 Mac 的 GitHub CLI 安装包")
        archive = (await client.get(assets[archive_name])).content
        sums = (await client.get(assets[sums_name])).text
    expected = next((line.split()[0] for line in sums.splitlines() if line.strip().endswith(archive_name)), "")
    if not expected or hashlib.sha256(archive).hexdigest() != expected:
        raise GitHubError("GitHub CLI 安装包校验失败，已放弃安装")
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        member = next((name for name in bundle.namelist() if name.endswith("/bin/gh")), None)
        if member is None:
            raise GitHubError("GitHub CLI 安装包里没有 gh")
        target = bin_dir(home) / "gh"
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".download")
        temporary.write_bytes(bundle.read(member))
        temporary.chmod(temporary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        temporary.replace(target)
    return str(target)


async def _run(gh: str, *args: str, timeout: float = 30) -> tuple[int, str, str]:
    process = await asyncio.create_subprocess_exec(gh, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                   env={**os.environ, "GH_PROMPT_DISABLED": "1", "NO_COLOR": "1"})
    try:
        out, err = await asyncio.wait_for(process.communicate(), timeout)
    except TimeoutError:
        process.kill()
        raise GitHubError("GitHub CLI 没有响应") from None
    return process.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


class GitHubAuth:
    """gh's device-flow login, run in the background while the person approves in the browser."""

    def __init__(self, home: Path):
        self.home = Path(home)
        self._login: asyncio.subprocess.Process | None = None
        self._code = ""
        self._error = ""

    async def gh(self) -> str:
        return find_gh(self.home) or await install_gh(self.home)

    async def user(self) -> dict[str, str] | None:
        """The logged-in GitHub user, or None."""
        gh = find_gh(self.home)
        if not gh:
            return None
        code, out, _ = await _run(gh, "api", "user")
        if code != 0:
            return None
        user = json.loads(out)
        return {"id": str(user.get("id", "")), "name": user.get("name") or user.get("login", ""), "handle": user.get("login", ""),
                "url": user.get("html_url", "")}

    async def start(self) -> dict[str, str]:
        """Start (or keep) the authorization; returns the one-time code to approve at github.com/login/device."""
        if self._login and self._login.returncode is None and self._code:
            return {"code": self._code, "url": DEVICE_URL}
        gh = await self.gh()
        self._code, self._error = "", ""
        # GH_BROWSER=true: gh must not open the person's default browser; AIOPC opens the page in its own.
        self._login = await asyncio.create_subprocess_exec(
            gh, "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            env={**os.environ, "GH_BROWSER": "true", "BROWSER": "true", "NO_COLOR": "1"})
        assert self._login.stdout is not None and self._login.stdin is not None
        seen = ""
        try:
            async with asyncio.timeout(30):
                while not self._code:
                    chunk = await self._login.stdout.read(256)
                    if not chunk:
                        break
                    seen += chunk.decode(errors="replace")
                    if match := CODE.search(seen):
                        self._code = match.group(1)
        except TimeoutError:
            pass
        if not self._code:
            self._login.kill()
            raise GitHubError(f"没有拿到 GitHub 授权码：{seen.strip()[-200:]}")
        # gh waits for Enter before "opening" the browser and then polls GitHub until the person approves.
        self._login.stdin.write(b"\n")
        await self._login.stdin.drain()
        asyncio.get_running_loop().create_task(self._drain())
        return {"code": self._code, "url": DEVICE_URL}

    async def _drain(self) -> None:
        process = self._login
        if not process or not process.stdout:
            return
        tail = (await process.stdout.read()).decode(errors="replace")
        await process.wait()
        if process.returncode:
            self._error = tail.strip()[-200:] or "GitHub 授权没有完成"

    def state(self) -> str:
        if self._login is None:
            return "idle"
        if self._login.returncode is None:
            return "waiting"
        return "failed" if self._login.returncode else "done"

    @property
    def error(self) -> str:
        return self._error
