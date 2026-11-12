"""Company inbox reads frozen approvals. Decisions always use the conversation MCP App."""
from starlette.requests import Request

from .review import PublishReview
from .service import SocialService


def publish_review_routes(workspace_of, resolve_context, respond):
    def owned_project(company, value):
        root = company.resolve_project(value)
        resolved, owner = resolve_context(str(root))
        return resolved if owner.root == company.root else None

    async def collection(request: Request):
        workspace = workspace_of(request)
        _, company = resolve_context(str(workspace.root))
        roots = [workspace.root]
        if workspace.root == company.root:
            base = company.root / "projects"
            if base.is_dir() and not base.is_symlink():
                for candidate in base.iterdir():
                    try:
                        owned = owned_project(company, str(candidate))
                        if owned is not None:
                            roots.append(owned)
                    except ValueError:
                        continue
        items = []
        for root in roots:
            reviews = PublishReview(SocialService(workspace.home, root))
            items.extend(reviews.recent())
        items.sort(key=lambda item: item["created_at"], reverse=True)
        pending = [item for item in items if item["status"] in ("awaiting_approval", "filling")]
        resolved = [item for item in items if item["status"] not in ("awaiting_approval", "filling")]
        return respond({"items": [*pending, *resolved[:100]]})

    async def item(request: Request):
        workspace = workspace_of(request)
        _, company = resolve_context(str(workspace.root))
        project = request.query_params.get("project", "")
        root = owned_project(company, project) if project else workspace.root
        if root is None or workspace.root not in (root, company.root):
            return respond({"error": "稿件不在当前项目"}, 404)
        review = PublishReview(SocialService(workspace.home, root)).read(request.path_params["review_id"], include_media=True)
        return respond(review) if review is not None else respond({"error": "稿件不存在"}, 404)

    return [
        ("/api/publish-reviews", collection, ["GET"]),
        ("/api/publish-reviews/{review_id}", item, ["GET"]),
    ]
