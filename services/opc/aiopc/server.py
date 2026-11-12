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
import asyncio
import base64
import inspect
import json
import logging
import os
import secrets
import shutil
import sys
from contextlib import ExitStack
from functools import partial
from pathlib import Path
from typing import Any, get_type_hints

from dotenv import load_dotenv
from mcp.server.fastmcp import Context, FastMCP, Image
from mcp.types import ToolAnnotations
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from aiopc.authorized_workspaces import AuthorizedWorkspaces
from aiopc.company import Company
from aiopc.environment_api import EnvironmentRoutes
from aiopc.knowledge import Knowledge
from aiopc.knowledge_routes import knowledge_routes
from aiopc.knowledge_tool import register_knowledge_tool
from aiopc.media.image import ImageService
from aiopc.media.video import VideoConfig, VideoService
from aiopc.platforms import catalog
from aiopc.project import Project, ProjectError
from aiopc.routine_routes import routine_routes
from aiopc.routines import LocalRoutines
from aiopc.runtime_context import RuntimeContextError, RuntimeContextResolver, use_runtime_context
from aiopc.sandbox import Sandboxes
from aiopc.sandbox.environment import SandboxError
from aiopc.sandbox.leases import LeaseError
from aiopc.skill_library_api import skill_library_routes
from aiopc.social.context import use_browser_context
from aiopc.social.review_mcp import register_publish_review
from aiopc.social.review_routes import publish_review_routes
from aiopc.social.service import SocialError, SocialService
from aiopc.space import SpaceCatalog
from aiopc.task_interfaces import TaskTools, task_routes
from aiopc.workspace_scope import WorkspaceScope
from aiopc.xdata import XDataService

READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
EXTERNAL = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=True)
INSTRUCTIONS = (
    "The workspace is a company. Its projects live under projects/<name>. Use the project parameter from the session instructions "
    "for project-related tool calls; never infer another project's path. Before writing, read get_project_brief; "
    "keep its memory in its files. Publishing first shows an approval card. Only a user-approved card fills the composer in the project environment; the user "
    "presses publish; never claim something is published until the user confirms. Generated images and videos are "
    "saved into the project's assets; show their paths. Use kb_query to retrieve documents and associated media."
)
ERRORS = (SocialError, ProjectError, ValueError, SandboxError)


class Workspace:
    """Every service for one workspace folder, built once and shared by tools and pages."""

    def __init__(self, home: Path, workspace: Path, *, company: Company | None = None):
        self.home, self.root = home.resolve(), workspace.resolve()
        self.company = company or Company.from_directory(self.root)
        self.project = Project(self.root)
        self.sandboxes = Sandboxes(self.home)
        self.social = SocialService(self.home, self.root, sandboxes=self.sandboxes)
        self.space = SpaceCatalog(self.root)
        self.knowledge = Knowledge(self.home, self.root, company_root=self.company.root)
        self.images = ImageService(self.home, self.root, reference_resolver=self.knowledge.resolve)
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


def _tool(server: FastMCP, name: str, method: Any, description: str, annotations: ToolAnnotations,
          scope: WorkspaceScope | None = None, runtime: RuntimeContextResolver | None = None) -> None:
    """Expose a service method with its own argument schema; errors become readable tool errors."""
    signature = inspect.signature(method)

    async def invoke(**kwargs: Any) -> Any:
        try:
            with ExitStack() as context:
                selected = kwargs.pop("project", "") if scope else ""
                if runtime and scope:
                    environment = kwargs.get("environment", "")
                    if "environment" not in signature.parameters:
                        kwargs.pop("environment", None)
                    context.enter_context(use_browser_context(environment=environment))
                    ctx = kwargs.pop("ctx", None)
                    try:
                        meta = ctx.request_context.meta if ctx else None
                    except (ValueError, LookupError):
                        meta = None
                    if ctx is None:
                        raise RuntimeContextError("浏览器操作需要可信会话上下文")
                    requested = str(scope.company.resolve_project(selected)) if selected else ""
                    identity = await runtime.resolve(meta, requested)
                    if identity.company != scope.company.root:
                        raise RuntimeContextError("会话不属于当前公司")
                    context.enter_context(use_runtime_context(identity))
                    selected = str(identity.project_directory) if identity.project_directory != scope.company.root else ""
                if scope:
                    context.enter_context(scope.use(selected))
                result = method(**kwargs)
                return await result if inspect.isawaitable(result) else result
        except ERRORS as exc:
            raise ValueError(getattr(exc, "message", None) or str(exc)) from None

    hints = get_type_hints(method)
    invoke.__name__ = name
    invoke.__doc__ = description
    invoke.__annotations__ = {**hints, "return": Any}
    parameters = [parameter.replace(annotation=hints.get(parameter.name, parameter.annotation))
                  for parameter in signature.parameters.values()]
    if scope:
        parameters.append(inspect.Parameter("project", inspect.Parameter.KEYWORD_ONLY, default="", annotation=str))
        invoke.__annotations__["project"] = str
    if runtime and "environment" not in signature.parameters:
        parameters.append(inspect.Parameter("environment", inspect.Parameter.KEYWORD_ONLY, default="", annotation=str))
        invoke.__annotations__["environment"] = str
    if runtime:
        parameters.append(inspect.Parameter("ctx", inspect.Parameter.KEYWORD_ONLY, annotation=Context))
        invoke.__annotations__["ctx"] = Context
    invoke.__signature__ = signature.replace(parameters=parameters, return_annotation=Any)  # type: ignore[attr-defined]
    server.tool(name=name, description=description, annotations=annotations)(invoke)


def create_server(home: Path, workspace: Path, library: Path | None = None) -> FastMCP:
    """The MCP server the agent runtime starts for one workspace."""
    scope = WorkspaceScope(home, workspace, Workspace)
    ws = scope.proxy()
    project, social = ws.project, ws.social
    server = FastMCP("aiopc", instructions=INSTRUCTIONS, log_level="WARNING")
    TaskTools(lambda project: scope.company.resolve_project(project or str(scope.default))).register(partial(_tool, server))
    runtime = RuntimeContextResolver(home)
    browser_tools = {"start_project_environment", "social_connect", "social_read", "login_open", "login_look",
                     "login_fill", "login_click", "login_screenshot", "login_finish"}
    register_knowledge_tool(server, ws.knowledge, READ)

    def get_project_brief() -> dict:
        """What the selected project knows: context, brand, memory, knowledge files, and the
        accounts it can use with each account's voice for this project. Read before writing anything."""
        return project.brief(social.accounts())

    def init_project(description: str = "") -> dict:
        """Create starter files in the selected project (CONTEXT.md, brand.md, MEMORY.md, knowledge/, assets/).
        Existing files are kept. Use only facts the user gave."""
        return project.init(description)

    async def create_video(prompt: str, first_frame: str = "", options: dict | None = None, request_id: str = "") -> dict:
        """Create a video from a prompt and optional first-frame image. Keep request_id stable to avoid duplicates."""
        return await ws.video().create(prompt, first_frame=first_frame or None, options=options, request_id=request_id or None)

    async def generate_image(prompt: str, aspect_ratio: str = "1:1", reference_images: list[str] | None = None,
                             count: int = 1, source_documents: list[str] | None = None) -> dict:
        if source_documents is not None and len(source_documents) > 20:
            raise ValueError("来源资料最多 20 个")
        sources = [str(ws.knowledge.resolve(str(ws.root / value))) for value in (source_documents or [])]
        result = await ws.images.generate(prompt, aspect_ratio, reference_images, count)
        await asyncio.to_thread(ws.knowledge.record_generation, result["images"], prompt, result["edited_from"] + sources)
        result["source_documents"] = sources
        return result

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
            if source != target:
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
        method: auto (this project's own environment), or browser for GitHub without CLI authorization.
        An account belongs to the environment it logged in to."""
        result = await social.connect(platform, alias, check, method=method)
        return _with_image(result, result.pop("screenshot", ""))

    xdata = ws.xdata
    for name, method, description, annotation in [
        ("get_project_brief", get_project_brief, get_project_brief.__doc__, READ),
        ("init_project", init_project, init_project.__doc__, WRITE),
        ("social_platforms", catalog, "Every platform AIOPC knows, grouped 国内 / 出海. All connect by logging in once in the project environment; fills_composer platforms can also get a post filled in via social_publish, the others you operate in the browser directly.", READ),
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
        ("social_history", social.history, "Recent publishing activity of this project (filled composers, published links).", READ),
        ("social_read", social.read, "Read an account's own posts, stats or comments/mentions (X: post_id reads replies to one post).", READ),
        ("generate_image", generate_image, "Generate images, or edit from up to 4 reference images. aspect_ratio 1:1, 3:4, 4:3, 9:16, 16:9. Saved into assets/generated; use source_documents to retain links to the material used to generate the image.", EXTERNAL),
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
        _tool(server, name, method, description, annotation, scope=scope, runtime=runtime if name in browser_tools else None)

    register_publish_review(server, scope, runtime, write=WRITE, external=EXTERNAL)

    if library is not None and library.is_dir():
        from aiopc.library import Library

        methods = Library(library)
        _tool(server, "library_list", methods.list, "List workflow/reference files in the methods library.", READ)
        _tool(server, "library_read", methods.read, "Read lines from a methods-library document.", READ)
        _tool(server, "library_search", methods.search, "Find literal text in the methods library.", READ)

    from aiopc.skillhub.script_tool import register_script_tool
    from aiopc.skillhub.tools import register_tools as register_skillhub_tools

    async def resolve_skill_session(meta):
        identity = await runtime.resolve(meta)
        if identity.company != scope.company.root:
            raise RuntimeContextError("技能工具只能用于此运行时所在公司的会话")
        return identity

    register_skillhub_tools(server, home, resolve_session=resolve_skill_session)
    register_script_tool(server, home, ws.sandboxes, resolve_session=resolve_skill_session)
    return server


def create_api(home: Path, token: str, *, authorized_roots=None) -> Starlette:
    """The HTTP API behind the app's pages. Every request names its workspace folder."""
    workspaces: dict[Path, Workspace] = {}
    workspace_access = AuthorizedWorkspaces(authorized_roots)
    cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type",
            "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS"}

    def respond(data: Any, status: int = 200) -> JSONResponse:
        return JSONResponse(data, status_code=status, headers={"Cache-Control": "no-store", **cors})

    def workspace_context(request: Request) -> tuple[Path, Company]:
        return workspace_access.resolve_context(request.query_params.get("workspace", ""))

    def project_directory(path: Path, company: Company) -> Path:
        if path == company.root:
            raise ValueError("请选择公司下的项目")
        return path

    def authorized_project(path: Path) -> Path:
        return project_directory(*workspace_access.resolve_context(str(path)))

    routines = LocalRoutines(home, authorize_project=authorized_project)

    def workspace_of(request: Request) -> Workspace:
        path, company = workspace_context(request)
        if path not in workspaces or workspaces[path].company.root != company.root:
            workspaces[path] = Workspace(home, path, company=company)
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
                return respond({"error": getattr(exc, "message", None) or str(exc), "code": getattr(exc, "code", "invalid_request")},
                               getattr(exc, "status", 409 if isinstance(exc, LeaseError) else 400))
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
        company = ws.company
        return respond(company.project(ws.root) if company.root != ws.root
                       else {**ws.project.describe(), "company": company.describe()})

    async def projects_route(request: Request) -> Response:
        company = workspace_of(request).company
        if request.method == "POST":
            data = await body(request)
            return respond(await asyncio.to_thread(company.create, data.get("name", ""), data.get("description", "")))
        return respond(await asyncio.to_thread(company.list))

    async def space_route(request: Request) -> Response:
        ws = workspace_of(request)
        exclusions = frozenset({"projects"}) if ws.knowledge.scope == "company" else frozenset()
        return respond(await asyncio.to_thread(ws.space.files, exclude_top=exclusions))

    async def platforms_route(_request: Request) -> Response:
        from aiopc.social.routes import ENHANCEMENTS

        # Every platform connects through the built-in browser; some also offer official ways in.
        return respond({"platforms": [{**item, "methods": ENHANCEMENTS.get(item["id"], [])} for item in catalog()]})

    def ui_browser_context(request, ws):
        environment = request.query_params.get("environment", "")
        owner = {"runtimeId": "desktop-ui", "sessionId": f"accounts:{ws.root}:{environment}",
                 "company": str(ws.company.root), "projectDirectory": str(ws.root),
                 "kind": "human", "label": "账号管理"}
        return use_browser_context(environment=environment, owner=owner)

    checking: dict[str, asyncio.Task[Any]] = {}

    async def accounts_route(request: Request) -> Response:
        ws = workspace_of(request)
        if request.query_params.get("check"):
            # Re-checking visits each platform; it runs in the background while the page keeps polling.
            key = str(ws.root) + ":" + request.query_params.get("environment", "")
            if key not in checking or checking[key].done():
                async def check_accounts():
                    try:
                        with ui_browser_context(request, ws):
                            return await ws.social.check_logins()
                    except Exception as exc:  # noqa: BLE001 - consume detached-task failures without logging CDP secrets
                        environment = request.query_params.get("environment", "")
                        safe_environment = environment if len(environment) <= 128 and environment.replace("_", "").replace("-", "").isalnum() else "default"
                        # Transport failures are not proof of logout. Do not log
                        # exception text: a CDP URL can contain a provider token.
                        logging.getLogger(__name__).warning(
                            "账号复查暂不可用：project=%s environment=%s error=%s；保留上次状态，下次轮询重试",
                            ws.root, safe_environment, type(exc).__name__,
                        )
                checking[key] = asyncio.get_running_loop().create_task(check_accounts())
        return respond({"accounts": ws.social.accounts()})

    async def connect_route(request: Request) -> Response:
        data = await body(request)
        # The app's page shows the browser panel itself, so no screenshot (and a faster answer).
        ws = workspace_of(request)
        with ui_browser_context(request, ws):
            result = await ws.social.connect(data.get("platform", ""), data.get("alias", ""), bool(data.get("check")),
                                             screenshot=False, method=str(data.get("method") or "auto"))
        result.pop("screenshot", None)
        return respond(result)

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
        *task_routes(lambda request: project_directory(*workspace_context(request)), body, respond),
        *routine_routes(routines, workspace_context, body, respond),
        *skill_library_routes(home, workspace_access, body, respond),
        ("/api/project", project_route, ["GET", "POST"]),
        ("/api/projects", projects_route, ["GET", "POST"]),
        ("/api/space", space_route, ["GET"]),
        *knowledge_routes(workspace_of, body, respond, cors),
        ("/api/platforms", platforms_route, ["GET"]),
        ("/api/accounts", accounts_route, ["GET"]),
        ("/api/accounts/connect", connect_route, ["POST"]),
        ("/api/accounts/connect-route", connect_route_route, ["POST"]),
        *EnvironmentRoutes(home, workspace_of, respond, body).routes(),
        ("/api/environment/providers", environment_providers_route, ["GET"]),
        ("/api/environment/providers/{provider_id}", environment_providers_route, ["PUT"]),
        ("/api/accounts/{account_id}", account_route, ["PATCH", "DELETE"]),
        ("/api/accounts/{account_id}/routes", account_routes_route, ["POST"]),
        ("/api/accounts/{account_id}/routes/{route_id}", account_routes_route, ["DELETE"]),
        ("/api/integrations", integrations_route, ["GET"]),
        ("/api/integrations/{service_id}", integrations_route, ["PUT"]),
        ("/api/history", history_route, ["GET"]),
        *publish_review_routes(workspace_of, workspace_access.resolve_context, respond),
    ]
    return Starlette(lifespan=routines.lifespan, routes=[
        Route("/api/health", health, methods=["GET"]),
        *[Route(path, endpoint(handler), methods=[*methods, "OPTIONS"]) for path, handler, methods in routes],
    ])


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
