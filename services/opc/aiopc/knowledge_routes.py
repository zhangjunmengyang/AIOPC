"""HTTP entry points for the desktop knowledge page."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from starlette.datastructures import UploadFile
from starlette.requests import Request
from starlette.responses import FileResponse

from aiopc.knowledge import MAX_FILE_BYTES


def knowledge_routes(workspace_of: Callable, body: Callable, respond: Callable, headers: dict[str, str]):
    async def catalog(request: Request):
        library = workspace_of(request).knowledge
        scope = request.query_params.get("scope", "project")
        return respond(await asyncio.to_thread(library.catalog, scope=scope))

    async def index(request: Request):
        library = workspace_of(request).knowledge
        data = await body(request) if await request.body() else {}
        return respond(await library.reindex(scope=data.get("scope", "project"), include_company="scope" not in data))

    async def search(request: Request):
        library = workspace_of(request).knowledge
        data = await body(request)
        return respond(await library.search(
            data.get("query", ""), data.get("limit", 8), scope=data.get("scope", "project"),
            kind=data.get("kind"), include_company="scope" not in data,
        ))

    async def annotate(request: Request):
        library = workspace_of(request).knowledge
        data = await body(request)
        return respond(await asyncio.to_thread(
            library.annotate, data.get("path", ""), data.get("alias"), data.get("description"),
            data.get("related_paths"), aliases=data.get("aliases"),
        ))

    async def import_files(request: Request):
        library = workspace_of(request).knowledge
        pending, total = [], 0
        async with request.form(max_files=20, max_fields=5, max_part_size=MAX_FILE_BYTES) as form:
            scope = form.get("scope", "project")
            for _, upload in form.multi_items():
                if not isinstance(upload, UploadFile):
                    continue
                data = await upload.read(MAX_FILE_BYTES + 1)
                if len(data) > MAX_FILE_BYTES:
                    raise ValueError("每个文件不能超过 32 MB")
                total += len(data)
                if total > 128 * 1024 * 1024:
                    raise ValueError("一次导入合计不能超过 128 MB")
                pending.append((upload.filename or "", data))
            if not pending:
                raise ValueError("请选择需要导入的文件")
            paths = {str(path) for path in await asyncio.to_thread(library.import_files, pending, scope=scope)}
        result = await asyncio.to_thread(library.catalog, scope=scope)
        return respond({"imported": len(paths), "items": [item for item in result["items"] if item["path"] in paths]})

    async def promote(request: Request):
        library = workspace_of(request).knowledge
        data = await body(request)
        return respond(await asyncio.to_thread(library.promote, data.get("path", "")))

    async def preview(request: Request):
        workspace = workspace_of(request)
        target = await asyncio.to_thread(workspace.knowledge.resolve, request.query_params.get("path", ""))
        mime = workspace.space.mime(target)
        file_headers = {**headers, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
        if mime in {"text/html", "image/svg+xml"}:
            file_headers["Content-Security-Policy"] = "sandbox"
        return FileResponse(target, media_type=mime, headers=file_headers)

    return [
        ("/api/knowledge", catalog, ["GET"]),
        ("/api/knowledge/index", index, ["POST"]),
        ("/api/knowledge/search", search, ["POST"]),
        ("/api/knowledge/asset", annotate, ["PATCH"]),
        ("/api/knowledge/import", import_files, ["POST"]),
        ("/api/knowledge/promote", promote, ["POST"]),
        ("/api/file", preview, ["GET"]),
    ]
