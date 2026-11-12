import asyncio
import json

import pytest
from starlette.testclient import TestClient

from aiopc.company import Company
from aiopc.server import create_api, create_server


def test_company_projects_are_stable_and_cannot_escape(tmp_path):
    root = tmp_path / "公司"
    root.mkdir()
    company = Company(root)
    first = company.create("产品 A", "给设计师的工具")
    second = company.create("产品 B", "给工程师的工具")
    assert first["id"] == "proj:产品 A"
    assert first["path"] == str(root / "projects" / "产品 A")
    assert company.resolve_project("产品 A") == root / "projects" / "产品 A"
    assert company.resolve_project(second["path"]) == root / "projects" / "产品 B"
    assert Company.from_directory(root / "projects" / "产品 A").root == root
    assert {item["id"] for item in company.list()["projects"]} == {"proj:产品 A", "proj:产品 B"}
    for value in ["../outside", str(tmp_path), ".hidden", "A/B"]:
        with pytest.raises(ValueError):
            company.create(value)
    external = tmp_path / "outside"
    external.mkdir()
    (root / "projects" / "linked").symlink_to(external, target_is_directory=True)
    with pytest.raises(ValueError):
        company.resolve_project("linked")


def test_creating_first_project_creates_company_skill_boundary_without_commits(tmp_path):
    import subprocess

    company = Company(tmp_path / "company")
    company.root.mkdir()
    company.create("alpha")
    assert (company.root / ".git").is_dir()
    result = subprocess.run(["git", "rev-list", "--all", "--count"], cwd=company.root,
                            capture_output=True, text=True, check=True)
    assert result.stdout.strip() == "0"
    config = company.root / ".git" / "config"
    before = config.read_bytes()
    company.create("beta")
    assert config.read_bytes() == before


async def test_mcp_project_parameter_routes_each_call_without_cross_project_state(tmp_path):
    company = Company(tmp_path / "company")
    company.root.mkdir()
    company.create("alpha", "甲项目的客户是设计师")
    company.create("beta", "乙项目的客户是工程师")
    server = create_server(tmp_path / "home", company.root)

    async def brief(project):
        value = await server.call_tool("get_project_brief", {"project": project})
        if isinstance(value, tuple):
            value = value[0]
        return json.loads(value[0].text)

    alpha = await brief("alpha")
    beta = await brief("projects/beta")
    assert "设计师" in alpha["context"] and "工程师" not in alpha["context"]
    assert "工程师" in beta["context"] and "设计师" not in beta["context"]
    assert alpha["project"]["path"].endswith("projects/alpha")
    assert (await brief("alpha"))["project"] == alpha["project"]
    with pytest.raises(Exception, match="项目"):
        await brief(str(tmp_path))
    tools = await server.list_tools()
    assert "project" in next(t for t in tools if t.name == "generate_image").inputSchema["properties"]


async def test_concurrent_mcp_calls_keep_their_own_project(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from aiopc.server import Workspace

    company = Company(tmp_path / "company")
    company.root.mkdir()
    company.create("alpha")
    company.create("beta")
    started = asyncio.Event()

    def video(self):
        async def create(prompt, **kwargs):
            if self.root.name == "alpha":
                started.set()
                await asyncio.sleep(0.02)
            return {"path": str(self.root), "prompt": prompt}
        return SimpleNamespace(create=create)

    monkeypatch.setattr(Workspace, "video", video)
    server = create_server(tmp_path / "home", company.root)
    first = asyncio.create_task(server.call_tool("create_video", {"prompt": "a", "project": "alpha"}))
    await started.wait()
    second = await server.call_tool("create_video", {"prompt": "b", "project": "beta"})
    first_result = await first
    for result, expected in [(first_result, "alpha"), (second, "beta")]:
        if isinstance(result, tuple):
            result = result[0]
        assert json.loads(result[0].text)["path"].endswith("projects/" + expected)


async def test_mcp_publish_card_retains_selected_project(tmp_path):
    from PIL import Image

    from aiopc.accounts import AccountStore

    company = Company(tmp_path / "company")
    company.root.mkdir()
    item = company.create("alpha")
    home = tmp_path / "home"
    image = company.resolve_project("alpha") / "cover.png"
    Image.new("RGB", (10, 10)).save(image)
    account = AccountStore(home).upsert("xhs", {"id": "test", "name": "测试号"}, project=item["path"])
    from aiopc.sandbox import Sandboxes
    pool = Sandboxes(home)
    resource = pool.create_environment(str(company.root), "测试环境", "local")
    await pool.bind(resource["id"], str(company.resolve_project("alpha")))
    AccountStore(home).assign_legacy_environment(str(company.resolve_project("alpha")), resource["id"])
    server = create_server(home, company.root)
    result = await server.call_tool("social_publish", {"account_id": account["id"], "text": "测试草稿", "project": "alpha",
                                                      "media": [str(image)]})
    assert result.structuredContent["project"] == item["path"]


def test_project_creation_api_and_project_description(tmp_path):
    root = tmp_path / "company"
    root.mkdir()
    client = TestClient(create_api(tmp_path / "home", "token", authorized_roots=[root]))
    headers = {"Authorization": "Bearer token"}
    created = client.post("/api/projects", params={"workspace": str(root)}, headers=headers,
                          json={"name": "alpha", "description": "设计工具"})
    assert created.status_code == 200
    assert created.json()["id"] == "proj:alpha"
    listed = client.get("/api/projects", params={"workspace": str(root)}, headers=headers).json()
    assert listed["company"]["path"] == str(root)
    assert listed["projects"][0]["description"] == "设计工具"
    project = client.get("/api/project", params={"workspace": created.json()["path"]}, headers=headers).json()
    assert project["company"]["path"] == str(root)
    assert project["id"] == "proj:alpha"
    assert "设计工具" in project["brief"]["context"]
    assert project["brief"]["brand"].startswith("# alpha")
