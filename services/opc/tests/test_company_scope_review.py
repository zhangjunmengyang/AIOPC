"""Project boundary regressions found during the phase-one review. No remote calls."""

import json
from types import SimpleNamespace

import httpx
import pytest
from starlette.testclient import TestClient

from aiopc.accounts import AccountStore
from aiopc.company import Company
from aiopc.media.video import VideoConfig, VideoService
from aiopc.server import create_api, create_server
from aiopc.social.review import RESOURCE
from aiopc.workspace_scope import WorkspaceScope


def company_fixture(tmp_path):
    company = Company(tmp_path / "company")
    company.root.mkdir()
    company.create("alpha")
    company.create("beta")
    return company


def tool_data(result):
    if isinstance(result, tuple):
        result = result[0]
    return [json.loads(item.text) for item in result]


@pytest.mark.parametrize("name", ["alpha\nbeta", "alpha\tbeta", "alpha\x7fbeta"])
def test_python_project_names_match_the_server_control_character_boundary(tmp_path, name):
    company = company_fixture(tmp_path)
    with pytest.raises(ValueError):
        company.create(name)


def test_project_alias_symlink_is_rejected_even_when_its_target_is_inside_company(tmp_path):
    company = company_fixture(tmp_path)
    alias = company.root / "projects" / "alias"
    alias.symlink_to(company.resolve_project("alpha"), target_is_directory=True)
    with pytest.raises(ValueError, match="符号链接"):
        company.resolve_project("alias")


@pytest.mark.parametrize("method", ["PATCH", "DELETE"])
def test_account_mutation_cannot_reach_another_projects_account(tmp_path, method):
    company = company_fixture(tmp_path)
    home = tmp_path / "home"
    store = AccountStore(home)
    account = store.upsert("x", {"id": "beta-id", "name": "乙账号"}, project=str(company.resolve_project("beta")))
    client = TestClient(create_api(home, "test-token", authorized_roots=[company.root]))
    response = client.request(method, f"/api/accounts/{account['id']}",
                              params={"workspace": str(company.resolve_project("alpha"))},
                              headers={"Authorization": "Bearer test-token"}, json={"alias": "被甲改名"})
    assert response.status_code == 400
    assert store.get(account["id"])["alias"] == ""


async def test_project_video_tools_do_not_list_other_projects_jobs(tmp_path, monkeypatch):
    company = company_fixture(tmp_path)
    home = tmp_path / "home"
    config = VideoConfig("https://example.com/contents/generations/tasks", "test-key", "test-model")
    monkeypatch.setattr(VideoConfig, "from_env", classmethod(lambda cls: config))
    alpha = VideoService(home, workspace=company.resolve_project("alpha"), config=config)
    job_id = "vid_" + "a" * 24
    alpha._save({"id": job_id, "model": config.model, "status": "failed", "created_at": 1,
                 "workspace": str(alpha.workspace)})
    server = create_server(home, company.root)
    assert tool_data(await server.call_tool("list_videos", {"project": "beta"})) == []


async def test_video_request_id_is_scoped_to_its_project(tmp_path):
    company = company_fixture(tmp_path)
    config = VideoConfig("https://example.com/contents/generations/tasks", "test-key", "test-model")
    submitted = []

    async def transport(request):
        submitted.append(request)
        return httpx.Response(200, json={"id": f"task-{len(submitted)}"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        alpha = VideoService(tmp_path / "home", workspace=company.resolve_project("alpha"), config=config, client=client)
        beta = VideoService(tmp_path / "home", workspace=company.resolve_project("beta"), config=config, client=client)
        first = await alpha.create("相同的视频需求", request_id="launch-video")
        second = await beta.create("相同的视频需求", request_id="launch-video")
    assert first["id"] != second["id"]
    assert len(submitted) == 2
    assert [item["id"] for item in alpha.list_jobs()] == [first["id"]]
    assert [item["id"] for item in beta.list_jobs()] == [second["id"]]


async def test_all_project_tools_have_project_schema_and_scope_restores_on_error(tmp_path):
    company = company_fixture(tmp_path)
    server = create_server(tmp_path / "home", company.root)
    schemas = {tool.name: tool.inputSchema["properties"] for tool in await server.list_tools()}
    assert set(schemas.pop("find_skill")) == {"query"}
    assert set(schemas.pop("adopt_skill")) == {"id", "scope"}
    for name, properties in schemas.items():
        assert properties.get("project", {}).get("type") == "string", name
    scope = WorkspaceScope(tmp_path / "home", company.root, lambda home, path: SimpleNamespace(root=path))
    with scope.use("alpha"):
        try:
            with scope.use("beta"):
                raise RuntimeError("cancelled inner operation")
        except RuntimeError:
            pass
        assert scope.current().root == company.resolve_project("alpha")
    assert scope.current().root == company.root


async def test_publish_card_confirmation_uses_its_original_project(tmp_path):
    company = company_fixture(tmp_path)
    home = tmp_path / "home"
    account = AccountStore(home).upsert("x", {"id": "alpha-id", "name": "甲账号"},
                                       project=str(company.resolve_project("alpha")))
    from aiopc.sandbox import Sandboxes
    pool = Sandboxes(home)
    resource = pool.create_environment(str(company.root), "测试环境", "local")
    await pool.bind(resource["id"], str(company.resolve_project("alpha")))
    AccountStore(home).assign_legacy_environment(str(company.resolve_project("alpha")), resource["id"])
    server = create_server(home, company.root)
    prepared = await server.call_tool("social_publish", {"account_id": account["id"], "text": "只准备不发布", "project": "alpha"})
    card = prepared.structuredContent
    ctx = SimpleNamespace(request_context=SimpleNamespace(meta=SimpleNamespace(
        model_dump=lambda: {"io.aiopc/app-action": {"approved": True, "resourceUri": RESOURCE}})))
    confirm = server._tool_manager.get_tool("social_confirm_publish").fn
    with pytest.raises(ValueError, match="稿件不存在"):
        await confirm(card["id"], card["digest"], "reject", ctx, project="beta")
    result = await confirm(card["id"], card["digest"], "reject", ctx, project=card["project"])
    assert result["status"] == "rejected"


def test_project_brief_ignores_voice_through_linked_account_directory(tmp_path):
    from aiopc.project import Project

    project = tmp_path / "company" / "projects" / "alpha"
    project.mkdir(parents=True)
    other = tmp_path / "private"
    other.mkdir()
    (other / "acc_test.md").write_text("其他项目的私有口吻", encoding="utf-8")
    (project / "accounts").symlink_to(other, target_is_directory=True)
    result = Project(project).brief([{"account_id": "acc_test"}])
    assert result["accounts"][0]["voice"] is None


def test_project_init_does_not_write_through_linked_knowledge_directory(tmp_path):
    from aiopc.project import Project, ProjectError

    project = tmp_path / "company" / "projects" / "alpha"
    project.mkdir(parents=True)
    other = tmp_path / "private"
    other.mkdir()
    (project / "knowledge").symlink_to(other, target_is_directory=True)
    with pytest.raises(ProjectError, match="项目"):
        Project(project).init("新的项目")
    assert list(other.iterdir()) == []
    assert not (project / "CONTEXT.md").exists()


def test_external_invalid_project_names_are_not_exposed_as_groups(tmp_path):
    from aiopc.company import Company

    company = Company(tmp_path / "company")
    base = company.root / "projects"
    base.mkdir(parents=True)
    (base / "valid").mkdir()
    for name in ["bad\nname", "trailing "]:
        (base / name).mkdir()
        with pytest.raises(ValueError, match="项目"):
            company.resolve_project(str(base / name))
    assert [item["id"] for item in company.list()["projects"]] == ["proj:valid"]
