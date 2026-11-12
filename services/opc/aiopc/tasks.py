"""Project work items. Markdown is the source of truth for both HTTP and MCP."""

from __future__ import annotations

import os
import re
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Annotated, Any, ClassVar, Literal
from uuid import uuid4

import yaml
from filelock import FileLock, Timeout
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

TASK_ID = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
MAX_DOCUMENT_BYTES = 1024 * 1024
FRONTMATTER = re.compile(r"\A---\r?\n(.*?)^---(?:\r?\n|\Z)", re.MULTILINE | re.DOTALL)
EDITABLE_FIELDS = ("title", "description", "status", "assignee", "parent", "blockedBy", "deliverables")

TaskId = Annotated[str, StringConstraints(pattern=TASK_ID)]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
Role = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=256)]
Status = Literal["todo", "in_progress", "in_review", "done", "blocked"]
Actor = Literal["user", "agent"]


class TaskError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class TaskDeliverable(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["file", "publish"]
    path: str
    label: str | None = None


class TaskActivity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    at: str
    actor: Actor
    action: Literal["created", "updated"]
    fields: list[str]


class Task(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: TaskId
    title: Title
    description: str = ""
    status: Status = "todo"
    assignee: Role | None = None
    parent: TaskId | None = None
    blockedBy: list[TaskId] = Field(default_factory=list)
    deliverables: list[TaskDeliverable] = Field(default_factory=list)
    createdAt: str
    updatedAt: str
    activity: list[TaskActivity] = Field(default_factory=list)


class _TaskLoader(yaml.SafeLoader):
    # Keep ISO dates written in an editor as strings, just like generated dates.
    yaml_implicit_resolvers: ClassVar = {
        first: [entry for entry in resolvers if entry[0] != "tag:yaml.org,2002:timestamp"]
        for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
    }


def _timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds")


def _change(at: str, actor: Actor, action: Literal["created", "updated"], fields: list[str]) -> TaskActivity:
    return TaskActivity(id=uuid4().hex, at=at, actor=actor, action=action, fields=fields)


class TaskStore:
    def __init__(self, project: Path):
        self.project = project.resolve()
        self.directory = self.project / "tasks"

    def _check_directory(self) -> None:
        if self.directory.is_symlink() or (self.directory.exists() and not self.directory.is_dir()):
            raise TaskError("任务目录必须是项目内的 tasks 文件夹")

    @contextmanager
    def _write_lock(self) -> Iterator[None]:
        self._check_directory()
        try:
            self.directory.mkdir(exist_ok=True)
            lock = self.directory / ".write.lock"
            if lock.is_symlink():
                raise TaskError("任务锁文件不能是符号链接")
            with FileLock(lock, timeout=5):
                yield
        except Timeout:
            raise TaskError("任务正在保存，请重试", 409) from None
        except OSError:
            raise TaskError("无法写入项目任务目录", 500) from None

    def _validate_deliverables(self, task: Task) -> None:
        for item in task.deliverables:
            path = PurePosixPath(item.path)
            if (not path.parts or path.is_absolute() or ".." in path.parts or ":" in item.path
                    or "\\" in item.path or any(ord(char) < 32 for char in item.path)
                    or not (self.project / path).resolve().is_relative_to(self.project)):
                raise TaskError("交付物必须使用项目内的相对文件路径")

    def _read(self, path: Path) -> Task:
        if path.is_symlink() or not path.is_file():
            raise TaskError("任务必须是 tasks 目录内的 Markdown 文件")
        try:
            with path.open("rb") as stream:
                document = stream.read(MAX_DOCUMENT_BYTES + 1)
            if len(document) > MAX_DOCUMENT_BYTES:
                raise TaskError("任务文件超过 1 MB")
            text = document.decode("utf-8")
            match = FRONTMATTER.match(text)
            if not match:
                raise TaskError("任务文件缺少 frontmatter")
            fields = yaml.load(match[1], Loader=_TaskLoader)
            if not isinstance(fields, dict) or fields.get("id", path.stem) != path.stem:
                raise TaskError("任务 ID 必须与文件名一致")
            timestamp = datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat(timespec="microseconds")
            fields.setdefault("createdAt", timestamp)
            fields.setdefault("updatedAt", fields["createdAt"])
            task = Task.model_validate({**fields, "id": path.stem, "description": text[match.end():].strip("\r\n")})
            self._validate_deliverables(task)
            return task
        except ValidationError as exc:
            raise TaskError(f"任务字段无效：{exc.errors()[0]['loc'][0]}") from None
        except (UnicodeDecodeError, OSError, RecursionError, yaml.YAMLError):
            raise TaskError("无法读取任务文件，请检查 Markdown 格式") from None

    def _all(self) -> tuple[dict[str, Task], list[dict[str, str]]]:
        self._check_directory()
        tasks = {}
        issues = []
        for path in sorted(self.directory.glob("*.md")):
            try:
                tasks[path.stem] = self._read(path)
            except TaskError as exc:
                issues.append({"file": path.name, "message": str(exc)})
        return tasks, issues

    @staticmethod
    def _pending_dependency(task: Task, tasks: dict[str, Task]) -> bool:
        return any(dependency not in tasks or tasks[dependency].status != "done" for dependency in task.blockedBy)

    def _view(self, task: Task, tasks: dict[str, Task]) -> dict[str, Any]:
        result = task.model_dump()
        if task.status not in {"done", "blocked"} and self._pending_dependency(task, tasks):
            result.update(status="blocked", requestedStatus=task.status)
        return result

    def list(self) -> dict[str, Any]:
        tasks, issues = self._all()
        ordered = sorted(tasks.values(), key=lambda item: (item.updatedAt, item.id), reverse=True)
        return {"items": [self._view(item, tasks) for item in ordered], "issues": issues}

    def _require(self, task_id: str, tasks: dict[str, Task]) -> Task:
        if not isinstance(task_id, str) or not re.fullmatch(TASK_ID, task_id):
            raise TaskError("任务 ID 无效")
        task = tasks.get(task_id)
        if task is None:
            raise TaskError("当前项目中没有此任务", 404)
        return task

    def get(self, task_id: str) -> dict[str, Any]:
        tasks, _ = self._all()
        return self._view(self._require(task_id, tasks), tasks)

    def _validate_links(self, candidate: Task, tasks: dict[str, Task]) -> None:
        for field in ("parent", "blockedBy"):
            initial = [candidate.parent] if field == "parent" and candidate.parent else []
            if field == "blockedBy":
                initial = candidate.blockedBy
            if len(initial) != len(set(initial)):
                raise TaskError("请移除重复的依赖任务")
            queue = initial.copy()
            visited: set[str] = set()
            while queue:
                task_id = queue.pop()
                if task_id == candidate.id:
                    raise TaskError("父任务或依赖不能形成循环")
                if task_id in visited:
                    continue
                visited.add(task_id)
                related = self._require(task_id, tasks)
                if field == "blockedBy":
                    queue.extend(related.blockedBy)
                elif related.parent:
                    queue.append(related.parent)

    def _edited(self, fields: dict[str, Any], current: Task | None, tasks: dict[str, Task], actor: Actor) -> Task:
        if set(fields).difference(EDITABLE_FIELDS):
            raise TaskError("请求包含无法修改的任务字段")
        at = _timestamp()
        base = current.model_dump() if current else {"id": uuid4().hex, "createdAt": at, "updatedAt": at}
        try:
            task = Task.model_validate({**base, **fields})
        except ValidationError as exc:
            raise TaskError(f"任务字段无效：{exc.errors()[0]['loc'][0]}") from None
        changed = [field for field in EDITABLE_FIELDS if field in fields and (current is None or getattr(task, field) != getattr(current, field))]
        if current and not changed:
            return current
        self._validate_deliverables(task)
        self._validate_links(task, tasks)
        if task.status == "done" and self._pending_dependency(task, tasks):
            raise TaskError("请先完成依赖任务", 409)
        task.updatedAt = at
        task.activity.append(_change(at, actor, "updated" if current else "created", changed))
        self._write(task)
        return task

    def _write(self, task: Task) -> None:
        destination = self.directory / f"{task.id}.md"
        if destination.is_symlink():
            raise TaskError("任务文件不能是符号链接")
        metadata = yaml.safe_dump(task.model_dump(exclude={"description"}, exclude_none=True), allow_unicode=True, sort_keys=False)
        data = f"---\n{metadata}---\n\n{task.description}\n".encode()
        if len(data) > MAX_DOCUMENT_BYTES:
            raise TaskError("任务文件超过 1 MB")
        fd, temporary = tempfile.mkstemp(prefix=".task-", dir=self.directory)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
            os.replace(temporary, destination)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def create(self, fields: dict[str, Any], *, actor: Actor = "user") -> dict[str, Any]:
        with self._write_lock():
            tasks, _ = self._all()
            return self._view(self._edited(fields, None, tasks, actor), tasks)

    def update(self, task_id: str, fields: dict[str, Any], *, actor: Actor = "user",
               expected_updated_at: str | None = None) -> dict[str, Any]:
        with self._write_lock():
            tasks, _ = self._all()
            current = self._require(task_id, tasks)
            if expected_updated_at is not None and current.updatedAt != expected_updated_at:
                raise TaskError("任务已更新，请刷新后重试", 409)
            return self._view(self._edited(fields, current, tasks, actor), tasks)

    def claim(self, task_id: str, role: str) -> dict[str, Any]:
        with self._write_lock():
            tasks, _ = self._all()
            current = self._require(task_id, tasks)
            if current.assignee not in (None, role):
                raise TaskError("任务已由其他角色领取", 409)
            if current.status not in {"todo", "in_progress"} or self._pending_dependency(current, tasks):
                raise TaskError("当前状态无法领取，请检查任务依赖和状态", 409)
            return self._view(self._edited({"assignee": role, "status": "in_progress"}, current, tasks, "agent"), tasks)
