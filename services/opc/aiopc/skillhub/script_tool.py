"""Execute a locked skill script using the current project's environment."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Literal, Protocol

from mcp.server.fastmcp import Context, FastMCP
from mcp.types import ToolAnnotations

from aiopc.sandbox.environment import SandboxError
from aiopc.sandbox.registry import Sandboxes
from aiopc.sandbox.skill_runner import run_skill_script as run_script_in_sandbox

from .adopt import installed_skill_name, resolve_adopted_script, verify_mirror

Scope = Literal["project", "company"]


class ScriptSession(Protocol):
    company: Path
    project_id: str | None
    project_directory: Path


def register_script_tool(
    server: FastMCP,
    home: Path,
    sandboxes: Sandboxes,
    *,
    resolve_session: Callable[[Any], Awaitable[ScriptSession]],
    authorize: Callable[[ScriptSession, str, Scope], Awaitable[bool]],
) -> None:
    @server.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False,
                                             openWorldHint=False))
    async def run_skill_script(
        skill_id: str, entry: str, ctx: Context, scope: Scope = "project", args: list[str] | None = None,
        environment: str = "",
    ) -> dict:
        """Run a vetted Python or sh entry from an adopted skill inside the current project's local Docker sandbox."""
        identity = await resolve_session(ctx.request_context.meta)
        if identity.project_id is None:
            raise ValueError("技能脚本需要在项目会话中运行")
        record, bundle = await asyncio.to_thread(
            resolve_adopted_script, home / "library", skill_id, company=identity.company,
            project=identity.project_directory, scope=scope, can_access_company=scope == "company",
        )
        if not await authorize(identity, installed_skill_name(record), scope):
            raise ValueError("当前角色无权运行这个技能")
        selected = sandboxes.resolve(str(identity.project_directory), environment)
        if selected["provider"] != "local":
            raise SandboxError("当前项目环境不支持隔离运行技能脚本，请选择绑定的本机 Docker 环境")
        return await run_script_in_sandbox(
            sandboxes.provider(selected["provider"]), bundle, entry, args or (),
            verify_staged=lambda staged: verify_mirror(record, staged),
        )
