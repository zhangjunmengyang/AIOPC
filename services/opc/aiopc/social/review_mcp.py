"""The MCP App prepares drafts and applies a decision from its trusted session."""
import json
from pathlib import Path

from mcp.server.fastmcp import Context, FastMCP
from mcp.types import CallToolResult, TextContent, ToolAnnotations

from aiopc.runtime_context import RuntimeContextError, RuntimeContextResolver, use_runtime_context
from aiopc.workspace_scope import WorkspaceScope

from .review import RESOURCE, PublishReview


def review_result(data: dict, **metadata) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(data, ensure_ascii=False))],
                          structuredContent=data, _meta=metadata or None)


def register_publish_review(server: FastMCP, scope: WorkspaceScope, runtime: RuntimeContextResolver,
                            *, write: ToolAnnotations, external: ToolAnnotations) -> None:
    async def origin(ctx: Context, project: str):
        meta = ctx.request_context.meta
        requested = str(scope.company.resolve_project(project)) if project else ""
        identity = await runtime.resolve(meta, requested)
        if identity.company != scope.company.root:
            raise RuntimeContextError("会话不属于当前公司")
        return identity

    @server.tool(name="social_publish", annotations=write, meta={"ui": {"resourceUri": RESOURCE}})
    async def social_publish(account_id: str, text: str, ctx: Context, title: str = "", media: list[str] | None = None,
                             form: str = "post", tags: list[str] | None = None, project: str = "",
                             previous_review_id: str = "") -> CallToolResult:
        """Prepare a frozen draft for user approval. This tool only prepares the draft.

        After the user returns a draft, pass its ID as previous_review_id when revising the same
        draft. The card shows the changes. The user approves and then clicks publish on the website.
        """
        identity = await origin(ctx, project)
        project = str(identity.project_directory) if identity.project_id else ""
        with scope.use(project) as selected, use_runtime_context(identity):
            reviews = PublishReview(selected.social)
            review = reviews.prepare(account_id, text, title, media, form, tags, session_id=identity.session_id,
                                     project=project, previous_review_id=previous_review_id)
            return review_result(review, media=reviews.preview_media(review))

    @server.tool(name="social_confirm_publish", annotations=external,
                 meta={"ui": {"resourceUri": RESOURCE, "visibility": ["app"]}})
    async def social_confirm_publish(review_id: str, revision: str, decision: str, ctx: Context, project: str = "") -> CallToolResult:
        """Apply the user's approval or return the draft. Approval fills the website composer."""
        meta = ctx.request_context.meta
        action = meta.model_dump().get("io.aiopc/app-action") if meta else None
        identity = await origin(ctx, project)
        selected_project = str(identity.project_directory) if identity.project_id else ""
        with scope.use(selected_project) as selected, use_runtime_context(identity):
            result = await PublishReview(selected.social).decide(review_id, revision, decision, app_action=action,
                                                                 session_id=identity.session_id)
            return review_result(result)

    @server.tool(name="social_record_published", annotations=write)
    async def social_record_published(account_id: str, url: str, ctx: Context, note: str = "", project: str = "") -> dict:
        """Record the public link of a post that the user confirmed they published."""
        identity = await origin(ctx, project)
        selected_project = str(identity.project_directory) if identity.project_id else ""
        with scope.use(selected_project) as selected:
            return selected.social.record_published(account_id, url, note, audit_session_id=identity.session_id)

    @server.resource(RESOURCE, mime_type="text/html;profile=mcp-app", meta={"ui": {"prefersBorder": True}})
    def publish_review_ui() -> str:
        return (Path(__file__).parent.parent / "ui" / "publish-review.html").read_text(encoding="utf-8")
