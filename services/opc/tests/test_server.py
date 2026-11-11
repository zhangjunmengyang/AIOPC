import asyncio
from pathlib import Path

from starlette.testclient import TestClient

from aiopc.server import create_api, create_server


async def _ready(value):
    """A browser that is already there, for tests that do not want an environment."""
    return value

TOKEN = "test-token"


def client(tmp_path: Path) -> TestClient:
    return TestClient(create_api(tmp_path / "home", TOKEN))


def auth() -> dict:
    return {"Authorization": f"Bearer {TOKEN}"}


def test_api_requires_token(tmp_path):
    api = client(tmp_path)
    assert api.get("/api/health").status_code == 200
    assert api.get("/api/project", params={"workspace": str(tmp_path)}).status_code == 401


def test_api_needs_a_real_workspace(tmp_path):
    response = client(tmp_path).get("/api/project", params={"workspace": "relative/path"}, headers=auth())
    assert response.status_code == 400


def test_workspace_is_the_project(tmp_path):
    api, workspace = client(tmp_path), tmp_path / "笔记应用"
    workspace.mkdir()
    params = {"workspace": str(workspace)}
    assert api.get("/api/project", params=params, headers=auth()).json()["name"] == "笔记应用"
    created = api.post("/api/project", params=params, json={"description": "记笔记"}, headers=auth()).json()
    assert "CONTEXT.md" in created["created"]
    assert "记笔记" in (workspace / "CONTEXT.md").read_text()
    # Existing files are kept.
    assert api.post("/api/project", params=params, json={}, headers=auth()).json()["created"] == []

    (workspace / ".opencode").mkdir()
    (workspace / ".opencode" / "secret.md").write_text("x")
    (workspace / "AGENTS.md").write_text("x")
    space = api.get("/api/space", params=params, headers=auth()).json()
    names = {item["relative"] for item in space["items"]}
    assert "CONTEXT.md" in names and "knowledge/README.md" in names
    assert "AGENTS.md" not in names and not any(name.startswith(".opencode") for name in names)

    brief = next(item for item in space["items"] if item["relative"] == "CONTEXT.md")
    assert brief["section"] == "brief"
    by_header = api.get("/api/file", params={**params, "path": brief["path"]}, headers=auth())
    by_query = api.get("/api/file", params={**params, "path": brief["path"], "token": TOKEN})
    assert by_header.status_code == by_query.status_code == 200
    hidden = api.get("/api/file", params={**params, "path": str(workspace / ".opencode" / "secret.md")}, headers=auth())
    outside = api.get("/api/file", params={**params, "path": str(tmp_path / "home")}, headers=auth())
    assert hidden.status_code == outside.status_code == 400


def test_an_account_belongs_to_the_project_it_logged_in_from(tmp_path):
    """A login lives in one project's environment, so another project does not see it."""
    from aiopc.accounts import AccountStore

    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    AccountStore(tmp_path / "home").upsert("小红书", {"id": "5f00", "name": "官方号"}, project=str(tmp_path / "a"))
    api = client(tmp_path)


    def listed(name):
        return [account["name"] for account in
                api.get("/api/accounts", params={"workspace": str(tmp_path / name)}, headers=auth()).json()["accounts"]]

    assert listed("a") == ["官方号"]
    assert listed("b") == []


def test_platform_catalog(tmp_path):
    platforms = client(tmp_path).get("/api/platforms", headers=auth()).json()["platforms"]
    assert len(platforms) > 40
    assert {"cn", "global"} == {item["region"] for item in platforms}


def test_cors_preflight(tmp_path):
    response = client(tmp_path).options("/api/project")
    assert response.status_code == 204 and response.headers["access-control-allow-origin"] == "*"


def test_mcp_tools(tmp_path):
    tools = asyncio.run(create_server(tmp_path / "home", tmp_path).list_tools())
    names = {tool.name for tool in tools}
    assert {"get_project_brief", "init_project", "social_platforms", "social_publish", "generate_image", "x_search"} <= names
    assert not any(name.startswith("library_") for name in names)


def test_library_from_config(tmp_path, monkeypatch):
    from aiopc.server import library_from

    monkeypatch.delenv("AIOPC_LIBRARY", raising=False)
    assert library_from(tmp_path) is None
    (tmp_path / "config.json").write_text('{"library": "~/methods"}')
    assert library_from(tmp_path) == Path("~/methods").expanduser()
    monkeypatch.setenv("AIOPC_LIBRARY", str(tmp_path))
    assert library_from(tmp_path) == tmp_path


def test_social_connect_shows_the_login_page_in_chat(tmp_path, monkeypatch):
    import base64

    from aiopc.social.service import SocialService

    png = base64.b64encode(b"\x89PNG fake").decode()

    class FakeBrowser:
        async def open_login(self, platform, screenshot=True):
            return {"tab_id": "t1", "screenshot": png if screenshot else ""}

    monkeypatch.setattr(SocialService, "browser", lambda self: _ready(FakeBrowser()))
    server = create_server(tmp_path / "home", tmp_path)
    content = asyncio.run(server.call_tool("social_connect", {"platform": "小红书"}))
    if isinstance(content, tuple):  # newer mcp returns (content, structured)
        content = content[0]
    kinds = [item.type for item in content]
    assert kinds == ["text", "image"]
    assert '"login_opened"' in content[0].text and "screenshot" not in content[0].text
