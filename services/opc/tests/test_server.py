import asyncio
from pathlib import Path

from starlette.testclient import TestClient

from aiopc.server import create_api, create_server

TOKEN = "test-token"


def client(tmp_path: Path) -> TestClient:
    return TestClient(create_api(tmp_path / "home", TOKEN))


def auth() -> dict:
    return {"Authorization": f"Bearer {TOKEN}"}


def test_api_requires_token(tmp_path):
    api = client(tmp_path)
    assert api.get("/api/health").status_code == 200
    assert api.get("/api/projects", params={"workspace": str(tmp_path)}).status_code == 401


def test_api_needs_a_real_workspace(tmp_path):
    response = client(tmp_path).get("/api/projects", params={"workspace": "relative/path"}, headers=auth())
    assert response.status_code == 400


def test_projects_space_and_files(tmp_path):
    api, workspace = client(tmp_path), tmp_path / "ws"
    workspace.mkdir()
    params = {"workspace": str(workspace)}
    created = api.post("/api/projects", params=params, json={"name": "笔记应用"}, headers=auth()).json()
    assert created["id"].startswith("project-")
    listed = api.get("/api/projects", params=params, headers=auth()).json()["projects"]
    assert created["id"] in {item["id"] for item in listed}

    space = api.get("/api/space", params={**params, "project": created["id"]}, headers=auth()).json()
    names = {item["relative"] for item in space["items"]}
    assert "project.json" not in names and "CONTEXT.md" in names

    brief = next(item for item in space["items"] if item["relative"] == "CONTEXT.md")
    by_header = api.get("/api/file", params={**params, "path": brief["path"]}, headers=auth())
    by_query = api.get("/api/file", params={**params, "path": brief["path"], "token": TOKEN})
    assert by_header.status_code == by_query.status_code == 200
    outside = api.get("/api/file", params={**params, "path": str(workspace / ".aiopc" / "accounts.json")}, headers=auth())
    assert outside.status_code == 400


def test_cors_preflight(tmp_path):
    response = client(tmp_path).options("/api/projects")
    assert response.status_code == 204 and response.headers["access-control-allow-origin"] == "*"


def test_mcp_tools(tmp_path):
    tools = asyncio.run(create_server(tmp_path / "home", tmp_path).list_tools())
    names = {tool.name for tool in tools}
    assert {"list_projects", "social_publish", "generate_image", "x_search"} <= names
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

    import aiopc.social.service as service

    png = base64.b64encode(b"\x89PNG fake").decode()

    class FakeBrowser:
        async def open_login(self, platform):
            return {"tab_id": "t1", "screenshot": png}

    monkeypatch.setattr(service, "OpenWorkBrowser", FakeBrowser)
    server = create_server(tmp_path / "home", tmp_path)
    content = asyncio.run(server.call_tool("social_connect", {"platform": "小红书"}))
    if isinstance(content, tuple):  # newer mcp returns (content, structured)
        content = content[0]
    kinds = [item.type for item in content]
    assert kinds == ["text", "image"]
    assert '"login_opened"' in content[0].text and "screenshot" not in content[0].text
