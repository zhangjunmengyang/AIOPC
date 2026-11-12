"""What AIOPC needs from an environment, whoever runs it.

An environment is one computer for one project: a real Chromium with a profile
that keeps its logins, a DevTools address the AI drives it through, and a live
picture the person can watch and take over in. A local Docker container and a
paid cloud browser both answer to this, so everything above — accounts,
publishing, reading — never learns which one it is talking to.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class SandboxError(RuntimeError):
    pass


@dataclass
class Environment:
    """A running (or not yet running) environment for one project."""

    provider: str
    status: str = "missing"  # running, starting, stopped, missing
    id: str = ""
    cdp_url: str = ""  # http://host:port or ws(s)://… — the DevTools address of the browser itself
    live_view_url: str = ""  # a page AIOPC embeds beside the chat; empty when the provider has no picture
    detail: str = ""
    expires_at: str = ""

    @property
    def running(self) -> bool:
        return self.status == "running" and bool(self.cdp_url)

    def describe(self) -> dict[str, Any]:
        return {"provider": self.provider, "status": self.status, "id": self.id, "live_view_url": self.live_view_url,
                # The DevTools address: AIOPC's own browsing tools drive the environment through it.
                "cdp_url": self.cdp_url,
                "detail": self.detail, "expires_at": self.expires_at, "running": self.running}


@dataclass
class Field:
    """One thing a provider needs from the person (an API key, an address)."""

    name: str
    label: str
    secret: bool = False
    optional: bool = False
    placeholder: str = ""


@dataclass
class ProviderInfo:
    id: str
    name: str
    kind: str  # local, cloud, manual
    summary: str
    fields: tuple[Field, ...] = ()
    help_url: str = ""
    persists_logins: bool = True

    def describe(self, *, configured: bool = False, available: bool = True, detail: str = "") -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "kind": self.kind, "summary": self.summary, "help_url": self.help_url,
                "persists_logins": self.persists_logins, "configured": configured, "available": available, "detail": detail,
                "fields": [{"name": f.name, "label": f.label, "secret": f.secret, "optional": f.optional,
                            "placeholder": f.placeholder} for f in self.fields]}


@dataclass
class ProjectKey:
    """A stable, readable name for a project's environment."""

    path: str
    name: str = ""
    _slug: str = field(default="", init=False)

    def __post_init__(self) -> None:
        import hashlib
        import re
        from pathlib import Path

        label = re.sub(r"[^a-z0-9]+", "-", (self.name or Path(self.path).name).lower()).strip("-")[:24] or "project"
        digest = hashlib.sha256(str(self.path).encode()).hexdigest()[:8]
        self._slug = f"{label}-{digest}"

    @property
    def slug(self) -> str:
        return self._slug


class Provider:
    """One way of running an environment. Providers are interchangeable."""

    info: ProviderInfo

    async def available(self) -> tuple[bool, str]:
        """Whether this provider can run right now, and why not when it cannot."""
        return True, ""

    async def ensure(self, key: ProjectKey, state: dict[str, Any]) -> Environment:
        """The project's environment, started if needed. Safe to call repeatedly.

        ``state`` is this project's saved record for this provider: providers read
        and write it (ports, session ids, passwords) and AIOPC stores it.
        """
        raise NotImplementedError

    async def status(self, key: ProjectKey, state: dict[str, Any]) -> Environment:
        raise NotImplementedError

    async def stop(self, key: ProjectKey, state: dict[str, Any]) -> None:
        return None

    async def destroy(self, key: ProjectKey, state: dict[str, Any]) -> None:
        return None

    async def reset(self, key: ProjectKey, state: dict[str, Any]) -> None:
        """Prove the entire old profile was removed before another project can bind."""
        raise SandboxError(f"{self.info.name} 无法自动清空完整浏览器档案，不能跨项目重新绑定此环境")
