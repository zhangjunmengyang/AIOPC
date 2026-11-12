import pytest
from starlette.testclient import TestClient

from aiopc.server import create_api, create_server


@pytest.fixture
def company_project(tmp_path):
    company = tmp_path / "company"
    project = company / "projects" / "alpha"
    project.mkdir(parents=True)
    return company, project


@pytest.mark.asyncio
async def test_desktop_board_and_mcp_share_authorized_project(company_project, tmp_path):
    company, project = company_project
    home = tmp_path / "home"
    mcp = create_server(home, company)
    assert "task_create" in {tool.name for tool in await mcp.list_tools()}
    await mcp.call_tool("task_create", {"project": str(project), "title": "春季发布", "assignee": "growth"})
    with TestClient(create_api(home, "test", authorized_roots=[company])) as api:
        headers = {"Authorization": "Bearer test"}
        result = api.get("/api/tasks", params={"workspace": str(project)}, headers=headers)
        assert result.status_code == 200
        item, = result.json()["items"]
        assert item["title"] == "春季发布" and item["assignee"] == "growth"
        forbidden = tmp_path / "other" / "projects" / "outside"
        forbidden.mkdir(parents=True)
        assert api.get("/api/tasks", params={"workspace": str(forbidden)}, headers=headers).status_code == 403
        assert api.get("/api/tasks", params={"workspace": str(company)}, headers=headers).status_code == 400
        assert api.get("/api/tasks", params={"workspace": str(project)}).status_code == 401
        updated = api.patch(f"/api/tasks/{item['id']}", params={"workspace": str(project)}, headers=headers,
                            json={"status": "done", "expectedUpdatedAt": item["updatedAt"]})
        assert updated.status_code == 200 and updated.json()["item"]["status"] == "done"


def test_routine_http_uses_same_company_authorization(company_project, tmp_path):
    company, project = company_project
    with TestClient(create_api(tmp_path / "home", "test", authorized_roots=[company])) as api:
        headers = {"Authorization": "Bearer test"}
        assert api.get("/api/routines", params={"workspace": str(project)}, headers=headers).json()["items"] == []
        assert api.get("/api/routine-results", params={"workspace": str(company)}, headers=headers).json() == {"items": []}
        assert api.get("/api/routine-results", params={"workspace": str(tmp_path)}, headers=headers).status_code == 403


def test_registered_company_inside_projects_is_not_an_outer_task_project(company_project, tmp_path):
    company, nested_company = company_project
    own_project = nested_company / "projects" / "own"
    own_project.mkdir(parents=True)
    with TestClient(create_api(tmp_path / "home", "test", authorized_roots=[company, nested_company])) as api:
        headers = {"Authorization": "Bearer test"}
        params = {"workspace": str(nested_company)}
        assert api.get("/api/tasks", params=params, headers=headers).status_code == 400
        assert api.get("/api/routines", params=params, headers=headers).status_code == 400
        assert api.get("/api/routine-results", params=params, headers=headers).json() == {"items": []}
        assert api.get("/api/tasks", params={"workspace": str(own_project)}, headers=headers).status_code == 200
