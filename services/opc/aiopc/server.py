"""AIOPC's OPC service: the AI's tools (MCP over stdio) and the app's pages (HTTP API).

Both call the same per-workspace services, so a page and the AI always see the
same project files and accounts. A workspace folder is a project; accounts and the methods library are shared.

    # MCP for the agent runtime; the workspace is the current directory unless given
    python -m aiopc.server --stdio [--workspace <dir>]
    # HTTP API for the desktop app, serving every workspace the app opens
    python -m aiopc.server --port 18800      (token from AIOPC_TOKEN)
"""

from __future__ import annotations

import argparse
import base64
import inspect
import json
import os
import secrets
import shutil
import sys
from pathlib import Path
from typing import Any, get_type_hints

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP, Image
from mcp.types import ToolAnnotations
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Route

from aiopc.media.image import ImageService
from aiopc.media.video import VideoConfig, VideoService
from aiopc.platforms import catalog
from aiopc.project import Project, ProjectError
from aiopc.sandbox import Sandboxes
from aiopc.social.service import SocialError, SocialService
from aiopc.space import SpaceCatalog
from aiopc.xdata import XDataService

READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
EXTERNAL = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=True)
INSTRUCTIONS = (
    "The current workspace folder is the project (one product). Before writing for it, read get_project_brief; "
    "keep its memory in its files. Publishing always fills the platform's composer in the built-in browser and the user "
    "presses publish; never claim something is published until the user confirms. Generated images and videos are "
    "saved into the project's assets; show their paths."
)
ERRORS = (SocialError, ProjectError, ValueError)


class Workspace:
    """Every service for one workspace folder, built once and shared by tools and pages."""

    def __init__(self, home: Path, workspace: Path):
        self.home, self.root = home.resolve(), workspace.resolve()
        self.project = Project(self.root)
        self.sandboxes = Sandboxes(self.home)
        self.social = SocialService(self.home, self.root, sandboxes=self.sandboxes)
        self.space = SpaceCatalog(self.root)
        self.images = ImageService(self.home, self.root)
        self.xdata = XDataService(self.home)
        self._video: VideoService | None = None

    def video(self) -> VideoService:
        # Built on first use: a missing video API must not take the whole service down.
        if self._video is None:
            try:
                self._video = VideoService(self.home, workspace=self.root, config=VideoConfig.from_env())
            except ValueError as exc:
                raise ValueError(f"视频服务未配置：{exc}。在 {self.home / '.env'} 填写视频接口后重启 AIOPC。") from None
        return self._video


def _with_image(result: dict[str, Any], png_base64: str) -> Any:
    """A tool answer that carries a picture (a QR code, a login page) alongside its data."""
    if not png_base64:
        return result
    return [json.dumps(result, ensure_ascii=False), Image(data=base64.b64decode(png_base64), format="png")]


def _tool(server: FastMCP, name: str, method: Any, description: str, annotations: ToolAnnotations) -> None:
    """Expose a service method with its own argument schema; errors become readable tool errors."""
    signature = inspect.signature(method)

    async def invoke(**kwargs: Any) -> Any:
        try:
            result = method(**kwargs)
            return await result if inspect.isawaitable(result) else result
        except ERRORS as exc:
            raise ValueError(getattr(exc, "message", None) or str(exc)) from None

    hints = get_type_hints(method)
    invoke.__name__ = name
    invoke.__doc__ = description
    invoke.__annotations__ = {**hints, "return": Any}
    invoke.__signature__ = signature.replace(  # type: ignore[attr-defined]
        parameters=[parameter.replace(annotation=hints.get(parameter.name, parameter.annotation))
                    for parameter in signature.parameters.values()], return_annotation=Any)
    server.tool(name=name, description=description, annotations=annotations)(invoke)


def create_server(home: Path, workspace: Path, library: Path | None = None) -> FastMCP:
    """The MCP server the agent runtime starts for one workspace."""
    ws = Workspace(home, workspace)
    project, social = ws.project, ws.social
    server = FastMCP("aiopc", instructions=INSTRUCTIONS, log_level="WARNING")

    def get_project_brief() -> dict:
        """What this project (the current workspace) knows: context, brand, memory, knowledge files, and the
        accounts it can use with each account's voice for this project. Read before writing anything."""
        return project.brief(social.accounts())

    def init_project(description: str = "") -> dict:
        """Create the project's starter files in this workspace (CONTEXT.md, brand.md, MEMORY.md, knowledge/, assets/).
        Existing files are kept. Use only facts the user gave."""
        return project.init(description)

    async def create_video(prompt: str, first_frame: str = "", options: dict | None = None, request_id: str = "") -> dict:
        """Create a video from a prompt and optional first-frame image. Keep request_id stable to avoid duplicates."""
        return await ws.video().create(prompt, first_frame=first_frame or None, options=options, request_id=request_id or None)

    async def get_video(job_id: str) -> dict:
        """Query a video job's real status."""
        return await ws.video().status(job_id)

    async def wait_video(job_id: str, timeout_s: float = 60) -> dict:
        """Wait a bounded time for a video job."""
        return await ws.video().wait(job_id, timeout_s=timeout_s, download=False)

    async def download_video(job_id: str) -> dict:
        """Download a finished video into this project's assets/generated and return its path."""
        result = await ws.video().download(job_id)
        source = Path(result.get("path") or result.get("file") or "")
        if source.is_file():
            target = project.assets / "generated" / source.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            result["path"] = str(target)
        return result

    def list_videos(limit: int = 20) -> list[dict]:
        """List saved video jobs."""
        return ws.video().list_jobs(limit)

    async def login_open(platform: str) -> Any:
        """Start logging in to a platform, in the chat. Opens its login page in this project's browser and returns
        what is on it: the fields, the buttons, and the QR code cut out as an image when there is one.
        Then: show the QR code to the user, or ask for the phone number, fill it with login_fill, press 获取验证码
        with login_click, ask for the code that arrived, fill it, press the login button, and call login_finish."""
        result = await social.login_open(platform)
        return _with_image(result, result.pop("qr_code", ""))

    async def login_look() -> Any:
        """Look at the login page again after the user did something (scanned, entered a code)."""
        result = await social.login_look()
        return _with_image(result, result.pop("qr_code", ""))

    async def login_screenshot() -> Any:
        """A picture of the whole login page, when the fields and buttons are not enough to tell what is going on."""
        return Image(data=base64.b64decode(await social.login_screenshot() or ""), format="png")

    async def social_connect(platform: str, alias: str = "", check: bool = False, method: str = "auto") -> Any:
        """Connect an account: the first call opens the platform's login page where this project's browser runs and
        shows it here (scan the QR code); after the user logs in, call again with check=true to detect and save it.
        method: auto (this project's own environment), sandbox or embedded (AIOPC's built-in browser). An account
        belongs to the environment it logged in to."""
        result = await social.connect(platform, alias, check, method=method)
        return _with_image(result, result.pop("screenshot", ""))

    xdata = ws.xdata
    for name, method, description, annotation in [
        ("get_project_brief", get_project_brief, get_project_brief.__doc__, READ),
        ("init_project", init_project, init_project.__doc__, WRITE),
        ("social_platforms", catalog, "Every platform AIOPC knows, grouped 国内 / 出海. All connect by logging in once in the built-in browser; fills_composer platforms can also get a post filled in via social_publish, the others you operate in the browser directly.", READ),
        ("social_accounts", social.accounts, "Connected accounts this project can use: status (ready / needs_login), forms (post / article / video) and readable data.", READ),
        ("project_environment", social.environment, "This project's environment: the computer its browser runs on (local sandbox or a cloud browser), whether it is running, and which providers are set up.", READ),
        ("start_project_environment", social.start_environment, "Start this project's environment if it is not running. Do this before connecting accounts or publishing when the environment is not up.", WRITE),
        ("social_connect", social_connect, social_connect.__doc__, WRITE),
        ("login_open", login_open, login_open.__doc__, WRITE),
        ("login_look", login_look, login_look.__doc__, READ),
        ("login_fill", social.login_fill, "Type into a login field, found by the words next to it (e.g. 手机号, 验证码, password).", WRITE),
        ("login_click", social.login_click, "Press a login button or tab by its visible text (e.g. 获取验证码, 登录, 密码登录).", WRITE),
        ("login_screenshot", login_screenshot, login_screenshot.__doc__, READ),
        ("login_finish", social.login_finish, "Check whether the login worked and save the account. Call after the user scanned or after pressing the login button.", WRITE),
        ("social_publish", social.publish, "Fill a platform's composer for one account, where that account is logged in; the user reviews and presses publish. Show the final copy and images to the user first.", EXTERNAL),
        ("social_record_published", social.record_published, "Record the public link of a post the user published, into the project's social log.", WRITE),
        ("social_history", social.history, "Recent publishing activity of this project (filled composers, published links).", READ),
        ("social_read", social.read, "Read an account's own posts, stats or comments/mentions (X: post_id reads replies to one post).", READ),
        ("generate_image", ws.images.generate, "Generate images, or edit from up to 4 reference images. aspect_ratio 1:1, 3:4, 4:3, 9:16, 16:9. Saved into this project's assets/generated; returns paths.", EXTERNAL),
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
        ("x_data_usage", xdata.usage, "Estimated third-party X data requests and cost over recent days.", READ),
    ]:
        _tool(server, name, method, description, annotation)

    if library is not None and library.is_dir():
        from aiopc.library import Library

        methods = Library(library)
        _tool(server, "library_list", methods.list, "List workflow/reference files in the methods library.", READ)
        _tool(server, "library_read", methods.read, "Read lines from a methods-library document.", READ)
        _tool(server, "library_search", methods.search, "Find literal text in the methods library.", READ)
    return server


def create_api(home: Path, token: str) -> Starlette:
    """The HTTP API behind the app's pages. Every request names its workspace folder."""
    workspaces: dict[Path, Workspace] = {}
    cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type",
            "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS"}

    def respond(data: Any, status: int = 200) -> JSONResponse:
        return JSONResponse(data, status_code=status, headers={"Cache-Control": "no-store", **cors})

    def workspace_of(request: Request) -> Workspace:
        value = request.query_params.get("workspace", "")
        path = Path(value).expanduser()
        if not value or not path.is_absolute() or not path.is_dir():
            raise ValueError("缺少有效的工作区路径")
        path = path.resolve()
        if path not in workspaces:
            workspaces[path] = Workspace(home, path)
        return workspaces[path]

    def authorized(request: Request) -> bool:
        # Images load through <img src>, which cannot send headers, so files also accept ?token=.
        supplied = request.headers.get("authorization", "").removeprefix("Bearer ") or request.query_params.get("token", "")
        return secrets.compare_digest(supplied, token)

    def endpoint(handler):
        async def wrapped(request: Request) -> Response:
            if request.method == "OPTIONS":
                return Response(status_code=204, headers=cors)
            if not authorized(request):
                return respond({"error": "unauthorized"}, 401)
            try:
                return await handler(request)
            except ERRORS as exc:
                return respond({"error": getattr(exc, "message", None) or str(exc)}, getattr(exc, "status", 400))
        return wrapped

    async def body(request: Request) -> dict[str, Any]:
        try:
            data = await request.json()
        except ValueError:
            raise ValueError("请求内容不是 JSON") from None
        if not isinstance(data, dict):
            raise ValueError("请求内容应为对象")  # noqa: TRY004 - surfaces as a 400 like every input error
        return data

    async def health(_request: Request) -> Response:
        return respond({"ok": True, "service": "aiopc"})

    async def project_route(request: Request) -> Response:
        ws = workspace_of(request)
        if request.method == "POST":
            data = await body(request)
            return respond(ws.project.init(str(data.get("description") or "")))
        return respond(ws.project.describe())

    async def space_route(request: Request) -> Response:
        return respond(workspace_of(request).space.files())

    async def file_route(request: Request) -> Response:
        ws = workspace_of(request)
        target = ws.space.resolve(request.query_params.get("path", ""))
        return FileResponse(target, media_type=ws.space.mime(target), headers={"Cache-Control": "no-store", **cors})

    async def platforms_route(_request: Request) -> Response:
        from aiopc.social.routes import ENHANCEMENTS

        # Every platform connects through the built-in browser; some also offer official ways in.
        return respond({"platforms": [{**item, "methods": ENHANCEMENTS.get(item["id"], [])} for item in catalog()]})

    async def accounts_route(request: Request) -> Response:
        return respond({"accounts": workspace_of(request).social.accounts()})

    async def connect_route(request: Request) -> Response:
        data = await body(request)
        # The app's page shows the browser panel itself, so no screenshot (and a faster answer).
        result = await workspace_of(request).social.connect(data.get("platform", ""), data.get("alias", ""), bool(data.get("check")),
                                                            screenshot=False, method=str(data.get("method") or "auto"))
        result.pop("screenshot", None)
        return respond(result)

    async def environment_route(request: Request) -> Response:
        """The project's environment: where its browser runs, and whether it is up."""
        ws = workspace_of(request)
        if request.method == "GET":
            return respond(await ws.social.environment())
        data = await body(request)
        action = str(data.get("action") or "start")
        if action == "start":
            return respond(await ws.social.start_environment())
        if action == "stop":
            return respond(await ws.sandboxes.stop(str(ws.root)))
        if action == "destroy":
            return respond(await ws.sandboxes.destroy(str(ws.root)))
        if action == "engine":
            return respond(ws.social.set_engine(str(data.get("engine") or "sandbox")))
        if action == "provider":
            return respond((await ws.sandboxes.move(str(ws.root), str(data.get("provider") or "local"))).describe())
        if action == "migrate":
            return respond(await ws.social.migrate_logins_now())
        if action == "install-engine":
            from aiopc.sandbox import install_engine

            return respond(await install_engine(str(data.get("engine_name") or "orbstack")))
        raise ValueError(f"不认识的操作：{action}")

    async def environment_providers_route(request: Request) -> Response:
        ws = workspace_of(request)
        if request.method == "PUT":
            data = await body(request)
            return respond(ws.sandboxes.configure(request.path_params["provider_id"], data.get("fields") or {}))
        return respond({"providers": await ws.sandboxes.describe_providers()})

    async def connect_route_route(request: Request) -> Response:
        data = await body(request)
        return respond(await workspace_of(request).social.connect_with_route(
            str(data.get("platform", "")), str(data.get("route", "")), data.get("fields") or {}, str(data.get("alias", ""))))

    async def account_route(request: Request) -> Response:
        ws, account_id = workspace_of(request), request.path_params["account_id"]
        if request.method == "DELETE":
            ws.social.remove(account_id)
            return respond({"deleted": True})
        data = await body(request)
        return respond(ws.social.update(account_id, alias=data.get("alias")))

    async def account_routes_route(request: Request) -> Response:
        ws, account_id = workspace_of(request), request.path_params["account_id"]
        if request.method == "DELETE":
            return respond(ws.social.remove_route(account_id, request.path_params["route_id"]))
        data = await body(request)
        return respond(await ws.social.add_route(account_id, str(data.get("route", "")), data.get("fields") or {}))

    async def integrations_route(request: Request) -> Response:
        ws = workspace_of(request)
        if request.method == "PUT":
            data = await body(request)
            return respond({"services": await ws.social.configure_service(request.path_params["service_id"], data.get("fields"))})
        return respond({"services": ws.social.services()})

    async def history_route(request: Request) -> Response:
        return respond({"items": workspace_of(request).social.history()})

    routes = [
        ("/api/project", project_route, ["GET", "POST"]),
        ("/api/space", space_route, ["GET"]),
        ("/api/file", file_route, ["GET"]),
        ("/api/platforms", platforms_route, ["GET"]),
        ("/api/accounts", accounts_route, ["GET"]),
        ("/api/accounts/connect", connect_route, ["POST"]),
        ("/api/accounts/connect-route", connect_route_route, ["POST"]),
        ("/api/environment", environment_route, ["GET", "POST"]),
        ("/api/environment/providers", environment_providers_route, ["GET"]),
        ("/api/environment/providers/{provider_id}", environment_providers_route, ["PUT"]),
        ("/api/accounts/{account_id}", account_route, ["PATCH", "DELETE"]),
        ("/api/accounts/{account_id}/routes", account_routes_route, ["POST"]),
        ("/api/accounts/{account_id}/routes/{route_id}", account_routes_route, ["DELETE"]),
        ("/api/integrations", integrations_route, ["GET"]),
        ("/api/integrations/{service_id}", integrations_route, ["PUT"]),
        ("/api/history", history_route, ["GET"]),
    ]
    return Starlette(routes=[Route("/api/health", health, methods=["GET"]),
                             *[Route(path, endpoint(handler), methods=[*methods, "OPTIONS"]) for path, handler, methods in routes]])


def library_from(home: Path) -> Path | None:
    """The methods library: AIOPC_LIBRARY, else "library" in ~/.aiopc/config.json."""
    value = os.environ.get("AIOPC_LIBRARY", "").strip()
    if not value:
        try:
            config = json.loads((home / "config.json").read_text(encoding="utf-8"))
            value = str(config.get("library") or "").strip() if isinstance(config, dict) else ""
        except (OSError, ValueError):
            value = ""
    return Path(value).expanduser() if value else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--workspace", type=Path, default=None, help="Workspace for --stdio (default: current directory)")
    parser.add_argument("--home", type=Path, default=Path(os.environ.get("AIOPC_HOME", "~/.aiopc")).expanduser())
    parser.add_argument("--library", type=Path, default=None, help="Methods library folder (default: AIOPC_LIBRARY)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("AIOPC_PORT", "18800")))
    parser.add_argument("--stdio", action="store_true", help="Serve MCP over stdio for one workspace")
    args = parser.parse_args()
    args.home.mkdir(parents=True, exist_ok=True, mode=0o700)
    load_dotenv(args.home / ".env", override=True)
    library = args.library or library_from(args.home)
    if args.stdio:
        create_server(args.home, args.workspace or Path.cwd(), library).run(transport="stdio")
        return
    token = os.environ.get("AIOPC_TOKEN") or secrets.token_urlsafe(24)
    if not os.environ.get("AIOPC_TOKEN"):
        # Run by hand: tell whoever started it how to reach the API.
        print(json.dumps({"url": f"http://127.0.0.1:{args.port}", "token": token}), file=sys.stderr, flush=True)
    import uvicorn

    uvicorn.run(create_api(args.home, token), host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
