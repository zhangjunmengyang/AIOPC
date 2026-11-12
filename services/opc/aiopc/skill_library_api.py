"""Desktop routes for the same catalog and hash-locked installer used by MCP."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from starlette.requests import Request
from starlette.responses import Response

from aiopc.authorized_workspaces import AuthorizedWorkspaces, WorkspaceForbidden
from aiopc.company import Company
from aiopc.skillhub.adopt import adopt_skill
from aiopc.skillhub.manifest import read_skills, skill_content
from aiopc.skillhub.search import SkillHub
from aiopc.skillhub.tools import _QmdSearch


def skill_library_routes(home: Path, workspace_access: AuthorizedWorkspaces, body, respond) -> list[tuple[str, Any, list[str]]]:
    """Register these handlers behind create_api's authenticated endpoint wrapper."""
    library = (home / "library").resolve()
    hub = SkillHub(library, _QmdSearch(home, library / "skills-index"))

    def company_of(request: Request) -> Company:
        root, company = workspace_access.resolve_context(request.query_params.get("workspace", ""))
        if root != company.root:
            raise WorkspaceForbidden("技能库需要已打开的公司根目录")
        return company

    def header_auth(request: Request) -> bool:
        # create_api validates the bearer token before dispatch. Its query-token
        # fallback exists for media URLs and must not authorize skill adoption.
        header = request.headers.get("authorization", "")
        return header.startswith("Bearer ") and bool(header.removeprefix("Bearer "))

    async def search_route(request: Request) -> Response:
        if not header_auth(request):
            return respond({"error": "unauthorized"}, 401)
        company_of(request)
        return respond(await hub.find_skill(request.query_params.get("q", "")))

    async def adopt_route(request: Request) -> Response:
        if not header_auth(request):
            return respond({"error": "unauthorized"}, 401)
        company = company_of(request)
        data = await body(request)
        identifier = data.get("id")
        commit = data.get("commit")
        scope = data.get("scope")
        if not isinstance(identifier, str) or not isinstance(commit, str) or scope not in ("project", "company"):
            raise ValueError("缺少技能、提交或采纳范围")
        project = None
        if scope == "project":
            name = data.get("project", "")
            if company.project_name(name) != name:
                raise ValueError("项目名称不能包含首尾空白")
            project, owner = workspace_access.resolve_context(str(company.root / "projects" / name))
            if owner.root != company.root:
                raise WorkspaceForbidden("目标目录不属于当前公司的项目")
        elif "project" in data:
            raise ValueError("采纳为公司技能时无需选择项目")

        record = (await asyncio.to_thread(read_skills, hub.root)).get(identifier)
        if record is None or record.id != identifier:
            raise ValueError("技能不存在，请重新搜索")
        if record.commit != commit:
            raise ValueError("技能版本已更新，请重新搜索后再采纳")
        return respond(await asyncio.to_thread(
            adopt_skill, record, skill_content(hub.root, record), company=company.root,
            project=project, scope=scope, can_adopt_company=scope == "company",
        ))

    return [
        ("/api/skillhub/search", search_route, ["GET"]),
        ("/api/skillhub/adopt", adopt_route, ["POST"]),
    ]
