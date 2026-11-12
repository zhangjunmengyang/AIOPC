"""Expose the same project task files to the board and the agent."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from mcp.types import ToolAnnotations
from pydantic import BaseModel, ConfigDict
from starlette.requests import Request
from starlette.responses import Response

from aiopc.tasks import Role, Status, TaskDeliverable, TaskError, TaskId, TaskStore, Title

READ_TASK = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
CREATE_TASK = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
UPDATE_TASK = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)


class TaskChanges(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Title | None = None
    description: str | None = None
    status: Status | None = None
    assignee: Role | None = None
    parent: TaskId | None = None
    blockedBy: list[TaskId] | None = None
    deliverables: list[TaskDeliverable] | None = None


class TaskTools:
    def __init__(self, resolve_project: Callable[[str], Path]):
        self.resolve_project = resolve_project

    def list(self, project: str = "") -> dict[str, Any]:
        return TaskStore(self.resolve_project(project)).list()

    def get(self, task_id: TaskId, project: str = "") -> dict[str, Any]:
        return TaskStore(self.resolve_project(project)).get(task_id)

    def create(self, title: Title, description: str = "", status: Status = "todo", assignee: Role | None = None,
               parent: TaskId | None = None, blocked_by: list[TaskId] | None = None,
               deliverables: list[TaskDeliverable] | None = None, project: str = "") -> dict[str, Any]:
        return TaskStore(self.resolve_project(project)).create({
            "title": title, "description": description, "status": status, "assignee": assignee, "parent": parent,
            "blockedBy": blocked_by or [], "deliverables": deliverables or [],
        }, actor="agent")

    def claim(self, task_id: TaskId, role: Role, project: str = "") -> dict[str, Any]:
        return TaskStore(self.resolve_project(project)).claim(task_id, role)

    def update(self, task_id: TaskId, changes: TaskChanges, project: str = "",
               expected_updated_at: str | None = None) -> dict[str, Any]:
        return TaskStore(self.resolve_project(project)).update(
            task_id, changes.model_dump(exclude_unset=True), actor="agent", expected_updated_at=expected_updated_at,
        )

    def register(self, register: Callable[[str, Callable, str, ToolAnnotations], None]) -> None:
        register("task_list", self.list, "List the selected project's tasks and their dependency status.", READ_TASK)
        register("task_get", self.get, "Read one project task, its deliverables, and its activity.", READ_TASK)
        register("task_create", self.create, "Create a Markdown task in the selected project.", CREATE_TASK)
        register("task_claim", self.claim, "Claim a ready task for your current role and start it.", UPDATE_TASK)
        register("task_update", self.update, "Update a task's status, role, dependencies, or project-relative deliverables.", UPDATE_TASK)


def task_routes(
    resolve_project: Callable[[Request], Path],
    body: Callable[[Request], Awaitable[dict[str, Any]]],
    respond: Callable[[Any, int], Response],
) -> list[tuple[str, Callable[[Request], Awaitable[Response]], list[str]]]:
    async def collection(request: Request) -> Response:
        store = TaskStore(resolve_project(request))
        if request.method == "POST":
            return respond({"item": store.create(await body(request))}, 201)
        return respond(store.list(), 200)

    async def detail(request: Request) -> Response:
        store = TaskStore(resolve_project(request))
        task_id = request.path_params["task_id"]
        if request.method == "PATCH":
            data = await body(request)
            expected_updated_at = data.pop("expectedUpdatedAt", None)
            if expected_updated_at is not None and not isinstance(expected_updated_at, str):
                raise TaskError("expectedUpdatedAt 必须是文字")
            item = store.update(task_id, data, expected_updated_at=expected_updated_at)
        else:
            item = store.get(task_id)
        return respond({"item": item}, 200)

    return [
        ("/api/tasks", collection, ["GET", "POST"]),
        ("/api/tasks/{task_id}", detail, ["GET", "PATCH"]),
    ]
