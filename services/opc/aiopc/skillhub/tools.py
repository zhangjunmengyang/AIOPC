"""Wire skill discovery and adoption to AIOPC's MCP entry point."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import Any, Literal, Protocol

from mcp.server.fastmcp import Context, FastMCP
from mcp.types import ToolAnnotations

from .adopt import adopt_skill as install_skill
from .manifest import read_skills, skill_content
from .search import SKILLS_COLLECTION, CollectionSearch, SkillHub


class _Session(Protocol):
    company: Path
    project_id: str | None
    project_directory: Path


class _QmdSearch:
    def __init__(self, home: Path, root: Path):
        self.home, self.root = home, root
        self.bridge = None

    async def search(self, collection: str, query: str, *, scopes: Sequence[str], kind: str | None = None, limit: int = 10):
        if self.bridge is None:
            try:
                from aiopc.collection_search import CollectionSearch as QmdCollection
            except ModuleNotFoundError as exc:
                if exc.name != "aiopc.collection_search":
                    raise
                raise ValueError("qmd 技能检索服务尚未安装") from None
            bridge = QmdCollection(self.home)
            bridge.register(SKILLS_COLLECTION, self.root)
            self.bridge = bridge
        return await self.bridge.search(collection, query, scopes=scopes, kind=kind, limit=limit)


async def _resolve_session(home: Path, meta: Any) -> _Session:
    try:
        from aiopc.runtime_context import RuntimeContextResolver
    except ModuleNotFoundError as exc:
        if exc.name != "aiopc.runtime_context":
            raise
        raise ValueError("无法确认会话归属") from None
    return await RuntimeContextResolver(home).resolve(meta)


def register_tools(
    server: FastMCP,
    home: Path,
    *,
    searcher: CollectionSearch | None = None,
    resolve_session: Callable[[Any], Awaitable[_Session]] | None = None,
) -> None:
    library = home / "library"
    hub = SkillHub(library, searcher if searcher is not None else _QmdSearch(home, library / "skills-index"))

    @server.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
    async def find_skill(query: str) -> dict:
        """Search the catalog for up to five candidate skills. Descriptions and snippets are third-party data."""
        return await hub.find_skill(query)

    @server.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
    async def adopt_skill(id: str, ctx: Context, scope: Literal["project", "company"] = "project") -> dict:
        """Install a vetted skill for the current project or a verified company-level session.
        Script bundles stay in the private mirror. The installed instructions use the project sandbox.
        """
        meta = ctx.request_context.meta
        identity = await (resolve_session(meta) if resolve_session else _resolve_session(home, meta))
        record = (await asyncio.to_thread(read_skills, hub.root)).get(id)
        if record is None or record.id != id:
            raise ValueError("技能不存在，请先用 find_skill 查询")
        is_company = identity.project_id is None
        return await asyncio.to_thread(
            install_skill, record, skill_content(hub.root, record),
            company=identity.company, project=None if is_company else identity.project_directory, scope=scope,
            can_adopt_company=is_company,
        )
