
import pytest
from mcp.server.fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from aiopc.server import _tool
from aiopc.task_interfaces import TaskTools, task_routes
from aiopc.tasks import TaskError


@pytest.fixture
def projects(tmp_path):
    for name in ("alpha", "beta"):
        (tmp_path / "projects" / name).mkdir(parents=True)

    def resolve(name):
        if name not in ("alpha", "beta"):
            raise TaskError("请选择当前公司的项目", 403)
        return tmp_path / "projects" / name

    return resolve


def http_client(resolve):
    async def body(request):
        return await request.json()

    def wrap(handler):
        async def wrapped(request):
            if request.headers.get("authorization") != "Bearer test":
                return JSONResponse({"error": "unauthorized"}, status_code=401)
            try:
                return await handler(request)
            except TaskError as error:
                return JSONResponse({"error": str(error)}, status_code=error.status)

        return wrapped

    routes = task_routes(lambda request: resolve(request.query_params["workspace"]), body, JSONResponse)
    return TestClient(Starlette(routes=[Route(path, wrap(handler), methods=methods) for path, handler, methods in routes]))


@pytest.mark.asyncio
async def test_mcp_and_http_share_the_project_markdown(projects):
    server = FastMCP("test")
    TaskTools(projects).register(lambda name, method, description, annotations: _tool(server, name, method, description, annotations))
    api = http_client(projects)
    headers = {"Authorization": "Bearer test"}
    alpha = {"workspace": "alpha"}
    assert api.get("/api/tasks", params=alpha).status_code == 401
    created = api.post("/api/tasks", params=alpha, headers=headers, json={"title": "待领取"}).json()["item"]
    tool_names = {tool.name for tool in await server.list_tools()}
    assert tool_names == {"task_create", "task_get", "task_list", "task_claim", "task_update"}
    await server.call_tool("task_claim", {"project": "alpha", "task_id": created["id"], "role": "growth"})
    await server.call_tool("task_update", {"project": "alpha", "task_id": created["id"], "changes": {"status": "in_review"}})
    task_path = f"/api/tasks/{created['id']}"
    item = api.get(task_path, params=alpha, headers=headers).json()["item"]
    assert item["assignee"] == "growth" and item["status"] == "in_review"
    assert item["activity"][-1]["actor"] == "agent"
    assert api.get(task_path, params={"workspace": "beta"}, headers=headers).status_code == 404
    assert api.get("/api/tasks", params={"workspace": "foreign"}, headers=headers).status_code == 403
    assert api.patch(task_path, params=alpha, headers=headers, json={"expectedUpdatedAt": created["updatedAt"]}).status_code == 409
    result = api.patch(task_path, params=alpha, headers=headers, json={"status": "done", "expectedUpdatedAt": item["updatedAt"]})
    assert result.status_code == 200 and result.json()["item"]["status"] == "done"


@pytest.mark.asyncio
async def test_mcp_create_uses_selected_project_and_keeps_markdown(tmp_path):
    resolver = lambda project: tmp_path / project
    resolver("beta").mkdir()
    server = FastMCP("test")
    TaskTools(resolver).register(lambda name, method, description, annotations: _tool(server, name, method, description, annotations))
    await server.call_tool("task_create", {"project": "beta", "title": "视频脚本", "description": "列出分镜。"})
    documents = list((tmp_path / "beta" / "tasks").glob("*.md"))
    assert len(documents) == 1 and "列出分镜。" in documents[0].read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_task_scan_does_not_stall_other_opc_work(projects, monkeypatch):
    import asyncio
    import threading

    from aiopc.tasks import TaskStore

    entered = threading.Event()
    release = threading.Event()
    original = TaskStore.list

    def slow_scan(self):
        entered.set()
        release.wait(timeout=0.2)
        return original(self)

    monkeypatch.setattr(TaskStore, "list", slow_scan)
    server = FastMCP("test")
    TaskTools(projects).register(lambda name, method, description, annotations: _tool(server, name, method, description, annotations))
    request = asyncio.create_task(server.call_tool("task_list", {"project": "alpha"}))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        assert not request.done()
    finally:
        release.set()
        await request
