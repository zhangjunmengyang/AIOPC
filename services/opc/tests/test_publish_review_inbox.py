import asyncio

from mcp.shared.memory import create_connected_server_and_client_session
from PIL import Image
from starlette.testclient import TestClient

from aiopc.accounts import AccountStore
from aiopc.runtime_context import RuntimeContextError, RuntimeContextResolver, RuntimeIdentity
from aiopc.server import create_api, create_server
from aiopc.social.review import RESOURCE, PublishReview
from aiopc.social.service import SocialService


def test_inbox_and_mcp_use_the_same_frozen_project_review(tmp_path, monkeypatch):
    company, outside, home = tmp_path / "company", tmp_path / "outside", tmp_path / "home"
    alpha, beta = company / "projects" / "alpha", company / "projects" / "beta"
    nested, projects = company / "projects" / "nested", company / "projects" / "projects"
    for path in (alpha, beta, outside, nested, projects):
        path.mkdir(parents=True)
    cover = alpha / "cover.png"
    Image.new("RGB", (40, 40), "red").save(cover)
    account = AccountStore(home).upsert("xhs", {"id": "fixture", "name": "测试账号"}, project=str(alpha))
    browser_calls = []

    class Browser:
        async def account(self, _platform):
            return {"id": "fixture"}

        async def compose(self, _platform, _form, **payload):
            browser_calls.append(payload)
            return {"page_url": "http://127.0.0.1/composer-fixture"}

    original = SocialService.__init__

    def isolated_social(self, *args, **kwargs):
        original(self, *args, **{**kwargs, "browser": Browser()})

    async def resolve(_resolver, meta, project=""):
        session_id = meta.model_dump().get("ai.opencode/sessionID") if meta else None
        if session_id not in ("ses_alpha", "ses_other") or (project and project != str(alpha)):
            raise RuntimeContextError("无法核实此会话的项目归属")
        return RuntimeIdentity("test-runtime", session_id, company, "proj:alpha", alpha, "Temporary review")

    monkeypatch.setattr(SocialService, "__init__", isolated_social)
    monkeypatch.setattr(RuntimeContextResolver, "resolve", resolve)
    server = create_server(home, company)
    api = TestClient(create_api(home, "temporary-token", authorized_roots=[company, nested]))
    api.headers["Authorization"] = "Bearer temporary-token"
    action = {"io.aiopc/app-action": {"approved": True, "resourceUri": RESOURCE}}
    origin = {"ai.opencode/sessionID": "ses_alpha"}

    def seed_draft(path, account_label):
        image = path / "cover.png"
        Image.new("RGB", (40, 40), "blue").save(image)
        separate_account = AccountStore(home).upsert("xhs", {"id": account_label, "name": account_label}, project=str(path))
        return PublishReview(SocialService(home, path)).prepare(separate_account["id"], "测试稿件", media=[str(image)],
                                                              project=str(path), session_id=f"ses_{account_label}")

    nested_draft, projects_draft = seed_draft(nested, "nested"), seed_draft(projects, "projects")

    async def run():
        async with create_connected_server_and_client_session(server) as mcp:
            args = {"account_id": account["id"], "text": "测试稿件", "media": [str(cover)]}
            assert (await mcp.call_tool("social_publish", args)).isError
            assert (await mcp.call_tool("social_publish", {**args, "project": str(beta)}, meta=origin)).isError
            prepared = await mcp.call_tool("social_publish", args, meta=origin)
            assert not prepared.isError
            draft = prepared.structuredContent
            assert draft["sessionId"] == "ses_alpha" and draft["project"] == str(alpha)
            assert not browser_calls
            assert api.get("/api/publish-reviews", params={"workspace": str(outside)}).status_code == 403
            assert api.get("/api/publish-reviews", params={"workspace": str(beta)}).json() == {"items": []}
            company_inbox = api.get("/api/publish-reviews", params={"workspace": str(company)}).json()
            assert [item["id"] for item in company_inbox["items"]] == [draft["id"], projects_draft["id"]]
            nested_path = "/api/publish-reviews/" + nested_draft["id"]
            assert api.get(nested_path, params={"workspace": str(company), "project": str(nested)}).status_code == 404
            assert api.get(nested_path, params={"workspace": str(nested)}).status_code == 200
            url = "/api/publish-reviews/" + draft["id"]
            params = {"workspace": str(company), "project": str(alpha)}
            assert api.get(url, params={**params, "workspace": str(beta)}).status_code == 404
            snapshot = api.get(url, params=params).json()
            assert snapshot["previewMedia"][0]["preview"].startswith("data:image/jpeg;base64,")
            decision = {"review_id": draft["id"], "revision": draft["digest"], "decision": "approve"}
            assert (await mcp.call_tool("social_confirm_publish", decision, meta=origin)).isError
            assert (await mcp.call_tool("social_confirm_publish", decision, meta={"ai.opencode/sessionID": "ses_other", **action})).isError
            assert not browser_calls
            for _ in range(2):
                receipt = await mcp.call_tool("social_confirm_publish", decision, meta={**origin, **action})
                assert not receipt.isError, receipt.content
                assert receipt.structuredContent["status"] == "composer_filled"
            assert len(browser_calls) == 1
            assert api.get(url, params=params).json()["status"] == "composer_filled"
            history = api.get("/api/history", params={"workspace": str(alpha)}).json()["items"]
            assert history[0]["session_id"] == "ses_alpha" and history[0]["action"] == "compose"
            recorded = await mcp.call_tool("social_record_published", {
                "account_id": account["id"], "url": "https://example.invalid/fixture",
            }, meta=origin)
            assert not recorded.isError
            history = api.get("/api/history", params={"workspace": str(alpha)}).json()["items"]
            assert history[0]["session_id"] == "ses_alpha" and history[0]["action"] == "published"
            assert len(browser_calls) == 1

    asyncio.run(run())
