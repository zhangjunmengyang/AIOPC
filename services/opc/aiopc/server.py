"""AIOPC's OPC service: one process serving the AI (MCP at /mcp) and the app's pages (HTTP at /api).

Both entry points call the same services, so a page and the AI always see the
same projects, accounts and files. Run with:

    python -m aiopc.server --workspace <dir> [--home ~/.aiopc] [--library <methods repo>] [--port 18800]
"""

from __future__ import annotations

import argparse
import inspect
import json
import os
import secrets
import shutil
import sys
from pathlib import Path
from typing import Any, get_type_hints

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response

from aiopc.accounts import PLATFORMS
from aiopc.media.image import ImageService
from aiopc.media.video import VideoConfig, VideoService
from aiopc.projects import ProjectError, ProjectService
from aiopc.social.service import SocialError, SocialService
from aiopc.space import SpaceCatalog
from aiopc.xdata import XDataService

READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
EXTERNAL = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=True)
INSTRUCTIONS = (
    "Work on explicit projects (the lab or workspace/projects/<id>) through files. Before writing for a project, "
    "read get_project_brief. Publishing always fills the platform's composer in the built-in browser and the user "
    "presses publish; never claim something is published until the user confirms. Generated images and videos are "
    "saved into the project's assets; show their paths."
)


def _tool(server: FastMCP, name: str, method: Any, description: str, annotations: ToolAnnotations) -> None:
    """Expose a service method with its own argument schema; errors become readable tool errors."""
    signature = inspect.signature(method)

    async def invoke(**kwargs: Any) -> Any:
        try:
            result = method(**kwargs)
            return await result if inspect.isawaitable(result) else result
        except (SocialError, ProjectError, ValueError) as exc:
            raise ValueError(getattr(exc, "message", None) or str(exc)) from None

    hints = get_type_hints(method)
    invoke.__name__ = name
    invoke.__doc__ = description
    invoke.__annotations__ = {**hints, "return": Any}
    invoke.__signature__ = signature.replace(  # type: ignore[attr-defined]
        parameters=[parameter.replace(annotation=hints.get(parameter.name, parameter.annotation))
                    for parameter in signature.parameters.values()], return_annotation=Any)
    server.tool(name=name, description=description, annotations=annotations)(invoke)


def create_server(home: Path, workspace: Path, library: Path | None = None, token: str = "") -> FastMCP:
    home, workspace = home.resolve(), workspace.resolve()
    projects = ProjectService(workspace)
    social = SocialService(home, workspace)
    space = SpaceCatalog(workspace)
    images = ImageService(home, workspace)
    videos: list[VideoService] = []

    def video() -> VideoService:
        # Built on first use: a missing video API must not take the whole service down.
        if not videos:
            try:
                videos.append(VideoService(home, workspace=workspace, config=VideoConfig.from_env()))
            except ValueError as exc:
                raise ValueError(f"视频服务未配置：{exc}。在 {home / '.env'} 填写视频接口后重启 AIOPC。") from None
        return videos[0]

    async def create_video(prompt: str, first_frame: str = "", options: dict | None = None, request_id: str = "") -> dict:
        """Create a video from a prompt and optional first-frame image. Keep request_id stable to avoid duplicates."""
        return await video().create(prompt, first_frame=first_frame or None, options=options, request_id=request_id or None)

    async def get_video(job_id: str) -> dict:
        """Query a video job's real status."""
        return await video().status(job_id)

    async def wait_video(job_id: str, timeout_s: float = 60) -> dict:
        """Wait a bounded time for a video job."""
        return await video().wait(job_id, timeout_s=timeout_s, download=False)

    def list_videos(limit: int = 20) -> list[dict]:
        """List saved video jobs."""
        return video().list_jobs(limit)
    xdata = XDataService(home)
    server = FastMCP("aiopc", instructions=INSTRUCTIONS)

    # ── projects ─────────────────────────────────────────────────────────
    def list_projects() -> list[dict]:
        """The lab and every project: id, name, description, folder."""
        return projects.list()

    def create_project(name: str, description: str = "") -> dict:
        """Create a project with starter brief, brand, knowledge/ and assets/. Use only facts the user gave."""
        return projects.create(name=name, description=description)

    def get_project_brief(project_id: str = "lab") -> dict:
        """What a scope knows: lab then project context and brand (project overrides lab), knowledge files,
        and the accounts it may use. Read before writing anything for a project."""
        accounts = [account for account in social.store.list(project_id)]
        return projects.brief(project_id, accounts)

    # ── media ────────────────────────────────────────────────────────────
    async def download_video(job_id: str, project_id: str = "lab") -> dict:
        """Download a finished video into the project's assets/generated and return its path."""
        result = await video().download(job_id)
        source = Path(result.get("path") or result.get("file") or "")
        if source.is_file():
            target = projects.scope_dir(project_id) / "assets" / "generated" / source.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            result["path"] = str(target)
        return result

    for name, method, description, annotation in [
        ("list_projects", list_projects, list_projects.__doc__, READ),
        ("create_project", create_project, create_project.__doc__, WRITE),
        ("get_project_brief", get_project_brief, get_project_brief.__doc__, READ),
        ("social_accounts", social.accounts, "Accounts this project may use on every platform: status (ready / needs_login), forms (post / article / video) and readable data.", READ),
        ("social_connect", social.connect, "Connect an account: first call opens the platform login page in the built-in browser; after the user logs in, call again with check=true to detect and save it (owner project_id, default lab).", WRITE),
        ("social_publish", social.publish, "Fill a platform's composer in the built-in browser for one account; the user reviews and presses publish. Show the final copy and images to the user first.", EXTERNAL),
        ("social_record_published", social.record_published, "Record the public link of a post the user published, into the project's social log.", WRITE),
        ("social_history", social.history, "Recent publishing activity of a project (filled composers, published links).", READ),
        ("social_read", social.read, "Read an account's own posts, stats or comments/mentions (X: post_id reads replies to one post).", READ),
        ("generate_image", images.generate, "Generate images, or edit from up to 4 reference images. aspect_ratio 1:1, 3:4, 4:3, 9:16, 16:9. Saved into the project's assets/generated; returns paths.", EXTERNAL),
        ("create_video", create_video, create_video.__doc__, EXTERNAL),
        ("get_video", get_video, get_video.__doc__, READ),
        ("wait_video", wait_video, wait_video.__doc__, READ),
        ("download_video", download_video, download_video.__doc__, WRITE),
        ("list_videos", list_videos, list_videos.__doc__, READ),
        ("x_search", xdata.search, "Search X posts via a cheap third-party cache (may lag minutes). Supports from:, \"phrase\", lang:, min_faves:, since:.", READ),
        ("x_user", xdata.user, "Read an X profile by username.", READ),
        ("x_user_posts", xdata.user_posts, "Read an X account's recent posts with metrics.", READ),
        ("x_mentions", xdata.mentions, "Read posts mentioning an X account.", READ),
        ("x_replies", xdata.replies, "Read replies to an X post (ID or URL).", READ),
        ("x_posts", xdata.posts, "Refresh metrics for up to 50 X posts by ID.", READ),
    ]:
        _tool(server, name, method, description, annotation)

    if library is not None:
        from aiopc.library import Library

        methods = Library(library)
        _tool(server, "library_list", methods.list, "List workflow/reference files in the methods library.", READ)
        _tool(server, "library_read", methods.read, "Read lines from a methods-library document.", READ)
        _tool(server, "library_search", methods.search, "Find literal text in the methods library.", READ)

    # ── HTTP for the app's own pages ─────────────────────────────────────
    def authorized(request: Request) -> bool:
        return not token or secrets.compare_digest(request.headers.get("authorization", ""), f"Bearer {token}")

    def json_response(data: Any, status: int = 200) -> JSONResponse:
        return JSONResponse(data, status_code=status, headers={"Cache-Control": "no-store"})

    def route(path: str, methods: list[str]):
        def decorator(handler):
            async def wrapped(request: Request) -> Response:
                if request.method == "OPTIONS":
                    return Response(status_code=204)
                if not authorized(request):
                    return json_response({"error": "unauthorized"}, 401)
                try:
                    return await handler(request)
                except (SocialError, ProjectError, ValueError) as exc:
                    return json_response({"error": getattr(exc, "message", None) or str(exc)}, getattr(exc, "status", 400))
            server.custom_route(path, methods=[*methods, "OPTIONS"])(wrapped)
            return wrapped
        return decorator

    @server.custom_route("/api/health", methods=["GET"])
    async def health(_request: Request) -> Response:
        return json_response({"ok": True, "service": "aiopc", "workspace": str(workspace)})

    @route("/api/projects", ["GET", "POST"])
    async def projects_route(request: Request) -> Response:
        if request.method == "POST":
            body = await request.json()
            return json_response(projects.create(name=body.get("name", ""), description=body.get("description", "")))
        return json_response({"projects": projects.list()})

    @route("/api/projects/{project_id}", ["PATCH"])
    async def project_route(request: Request) -> Response:
        body = await request.json()
        return json_response(projects.update(request.path_params["project_id"], body.get("name"), body.get("description")))

    @route("/api/space", ["GET"])
    async def space_route(request: Request) -> Response:
        return json_response(space.files(request.query_params.get("project") or "lab"))

    @route("/api/file", ["GET"])
    async def file_route(request: Request) -> Response:
        target = space.resolve(request.query_params.get("path", ""))
        return FileResponse(target, media_type=space.mime(target), headers={"Cache-Control": "no-store"})

    @route("/api/platforms", ["GET"])
    async def platforms_route(_request: Request) -> Response:
        from aiopc.social.openwork import MULTIPOST_KEYS

        return json_response({"platforms": [{"id": key, "name": name, "forms": list(MULTIPOST_KEYS.get(key, {}))}
                                            for key, name in PLATFORMS.items() if key in MULTIPOST_KEYS]})

    @route("/api/accounts", ["GET"])
    async def accounts_route(request: Request) -> Response:
        everywhere = request.query_params.get("all") == "1"
        return json_response({"accounts": social.accounts(request.query_params.get("project") or "lab", all_scopes=everywhere)})

    @route("/api/accounts/connect", ["POST"])
    async def connect_route(request: Request) -> Response:
        body = await request.json()
        return json_response(await social.connect(body.get("platform", ""), body.get("project") or "lab",
                                                  body.get("alias", ""), bool(body.get("check"))))

    @route("/api/accounts/{account_id}", ["PATCH", "DELETE"])
    async def account_route(request: Request) -> Response:
        account_id = request.path_params["account_id"]
        if request.method == "DELETE":
            social.remove(account_id)
            return json_response({"deleted": True})
        body = await request.json()
        changes = {key: body[key] for key in ("alias", "shared_with") if key in body}
        if "project" in body:
            changes["project_id"] = None if body["project"] in ("", "lab", None) else body["project"]
        return json_response(social.update(account_id, **changes))

    @route("/api/history", ["GET"])
    async def history_route(request: Request) -> Response:
        return json_response({"items": social.history(request.query_params.get("project") or "lab")})

    return server


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=os.environ.get("AIOPC_WORKSPACE"))
    parser.add_argument("--home", type=Path, default=Path(os.environ.get("AIOPC_HOME", "~/.aiopc")).expanduser())
    parser.add_argument("--library", type=Path, default=os.environ.get("AIOPC_LIBRARY") or None)
    parser.add_argument("--port", type=int, default=int(os.environ.get("AIOPC_PORT", "18800")))
    parser.add_argument("--stdio", action="store_true", help="Serve MCP over stdio instead of HTTP")
    args = parser.parse_args()
    if args.workspace is None:
        sys.exit("--workspace (or AIOPC_WORKSPACE) is required")
    args.home.mkdir(parents=True, exist_ok=True, mode=0o700)
    load_dotenv(args.home / ".env", override=True)
    if args.stdio:
        create_server(args.home, args.workspace, args.library).run(transport="stdio")
        return
    token = secrets.token_urlsafe(24)
    server = create_server(args.home, args.workspace, args.library, token)
    server.settings.host, server.settings.port = "127.0.0.1", args.port
    # The app reads this to reach the HTTP pages API; the MCP endpoint is for the agent runtime.
    state = args.home / "service.json"
    state.write_text(json.dumps({"url": f"http://127.0.0.1:{args.port}", "token": token, "pid": os.getpid(),
                                 "workspace": str(args.workspace.resolve())}) + "\n")
    state.chmod(0o600)
    server.run(transport="streamable-http")


if __name__ == "__main__":
    main()
