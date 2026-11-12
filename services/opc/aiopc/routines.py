"""Persistent project Automations and their local inbox receipts."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import time
from collections.abc import Callable
from contextlib import asynccontextmanager, contextmanager, suppress
from pathlib import Path
from uuid import uuid4

from filelock import FileLock, Timeout

from aiopc.routine_runner import run_local_routine
from aiopc.routine_schedule import latest_occurrence, next_occurrence, parse_schedule

logger = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, company TEXT NOT NULL, project TEXT NOT NULL,
  name TEXT NOT NULL, instructions TEXT NOT NULL, agent TEXT, model TEXT,
  schedule TEXT NOT NULL, state TEXT NOT NULL, next_due INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS routines_project ON routines(project, state);
CREATE INDEX IF NOT EXISTS routines_due ON routines(next_due) WHERE state='active';
CREATE TABLE IF NOT EXISTS routine_runs (
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES routines(id),
  definition TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL,
  scheduled_at INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  result TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS routine_run_history ON routine_runs(routine_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS routine_run_pending ON routine_runs(routine_id)
  WHERE status IN ('queued', 'running');
"""


class RoutineError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _text(value, label, maximum):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= maximum or "\0" in value:
        raise RoutineError(f"{label}需为 1–{maximum} 字")
    return value.strip()


def _model(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise RoutineError("模型配置应包含提供商和模型名")
    model = {key: _text(value.get(key), label, 160)
             for key, label in (("providerId", "提供商"), ("modelId", "模型名"))}
    if value.get("variant") is not None:
        model["variant"] = _text(value["variant"], "推理级别", 60)
    return model


def _role_directories(company: Path):
    config = company / ".opencode"
    for name in ("agents", "agent"):
        path = config / name
        if not config.is_symlink() and not path.is_symlink() and path.is_dir():
            yield path


def _roles(company: Path) -> dict[str, Path]:
    roles = {}
    for directory in _role_directories(company):
        for path in sorted(directory.glob("*.md")):
            if not path.name.startswith(".") and not path.is_symlink() and path.is_file():
                roles.setdefault(path.stem, path)
    return roles


def _role_prompt(company: Path, agent: str | None) -> str:
    if not agent:
        return ""
    path = _roles(company).get(agent)
    if path is None:
        raise RoutineError("所选角色已不存在，请修改例行任务")
    with path.open(encoding="utf-8") as file:
        text = file.read(16000)
    if text.startswith("---\n"):
        _, separator, body = text[4:].partition("\n---\n")
        text = body if separator else ""
    return text.strip()


def _routine(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "companyRoot": row["company"], "projectRoot": row["project"],
            "name": row["name"], "instructions": row["instructions"], "agent": row["agent"],
            "model": json.loads(row["model"]) if row["model"] else None, "schedule": json.loads(row["schedule"]),
            "state": row["state"], "nextDueAt": row["next_due"], "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


def _receipt(row: sqlite3.Row) -> dict:
    definition = json.loads(row["definition"])
    return {"id": row["id"], "kind": "routine_run", "routineId": row["routine_id"],
            "name": definition["name"], "agent": definition["agent"], "projectRoot": definition["projectRoot"],
            "trigger": row["trigger"], "status": row["status"], "scheduledAt": row["scheduled_at"],
            "createdAt": row["created_at"], "startedAt": row["started_at"], "finishedAt": row["finished_at"],
            "result": row["result"], "error": row["error"]}


class LocalRoutines:
    def __init__(self, home: Path, *, authorize_project: Callable[[Path], Path] | None = None,
                 now=None, runner=None, launcher: Path | None = None):
        self.directory = home / "routines"
        self.path = self.directory / "automations.sqlite"
        self.authorize_project = authorize_project
        self.now = now or (lambda: time.time_ns() // 1_000_000)
        configured = os.environ.get("OPENCODE_SCHEDULER_OPENCODE_PATH")
        self.launcher = launcher or (Path(configured) if configured else None)
        self.runner = runner
        self._initialized = False

    @contextmanager
    def _db(self, *, write=False):
        if not self._initialized:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.path.touch(mode=0o600, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys = ON")
            if not self._initialized:
                db.executescript(SCHEMA)
                self._initialized = True
            with db:
                if write:
                    db.execute("BEGIN IMMEDIATE")
                yield db
        finally:
            db.close()

    def _project(self, project: Path) -> Path:
        if (not project.is_absolute() or project.parent.name != "projects" or project.name.startswith(".")
                or project.resolve() != project or not project.is_dir()):
            raise RoutineError("请选择公司下的项目目录", 404)
        if self.authorize_project and self.authorize_project(project) != project:
            raise RoutineError("项目已不在当前授权范围", 403)
        return project

    @staticmethod
    def _get(db, project, routine_id):
        row = db.execute("SELECT * FROM routines WHERE project=? AND id=? AND state != 'archived'",
                         (str(project), routine_id)).fetchone()
        if not row:
            raise RoutineError("找不到这条例行任务", 404)
        return row

    def list(self, project: Path) -> dict:
        project = self._project(project)
        with self._db() as db:
            rows = db.execute("SELECT * FROM routines WHERE project=? AND state!='archived' ORDER BY created_at DESC, id",
                              (str(project),)).fetchall()
        return {"items": [_routine(row) for row in rows], "agents": sorted(_roles(project.parent.parent)),
                "canRun": self.runner is not None or (self.launcher is not None and self.launcher.is_file())}

    def _definition(self, project, draft, now, current=None):
        if current:
            draft = {**current, **draft}
        name = _text(draft.get("name"), "名称", 120)
        instructions = _text(draft.get("instructions"), "任务说明", 100000)
        state = draft.get("state", "active")
        if state not in ("active", "inactive"):
            raise RoutineError("例行任务状态无效")
        agent = draft.get("agent")
        if agent is not None:
            agent = _text(agent, "角色", 160)
            if agent not in _roles(project.parent.parent):
                raise RoutineError("请选择公司内的角色")
        schedule = parse_schedule(draft.get("schedule"))
        due = None
        if state == "active":
            if current and current["state"] == state and current["schedule"] == schedule:
                due = current["nextDueAt"]
            else:
                due = next_occurrence(schedule, now)
                if due is None:
                    raise RoutineError("单次任务的运行时间应晚于现在")
        model = _model(draft.get("model"))
        return (name, instructions, agent, json.dumps(model) if model else None, json.dumps(schedule), state, due)

    def create(self, project: Path, draft: dict) -> dict:
        project = self._project(project)
        now, routine_id = self.now(), uuid4().hex
        values = self._definition(project, draft, now)
        with self._db(write=True) as db:
            db.execute("INSERT INTO routines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                       (routine_id, str(project.parent.parent), str(project), *values, now, now))
            return _routine(self._get(db, project, routine_id))

    def update(self, project: Path, routine_id: str, draft: dict) -> dict:
        project = self._project(project)
        now = self.now()
        with self._db(write=True) as db:
            current = _routine(self._get(db, project, routine_id))
            values = self._definition(project, draft, now, current)
            db.execute("UPDATE routines SET name=?, instructions=?, agent=?, model=?, schedule=?, state=?, next_due=?, updated_at=? WHERE id=?",
                       (*values, now, routine_id))
            return _routine(self._get(db, project, routine_id))

    def archive(self, project: Path, routine_id: str) -> None:
        project = self._project(project)
        now = self.now()
        with self._db(write=True) as db:
            self._get(db, project, routine_id)
            db.execute("UPDATE routines SET state='archived', next_due=NULL, updated_at=? WHERE id=?", (now, routine_id))
            db.execute("UPDATE routine_runs SET status='cancelled', finished_at=?, error=? WHERE routine_id=? AND status='queued'",
                       (now, "例行任务已删除", routine_id))

    @staticmethod
    def _insert_run(db, routine, trigger, now, due=None):
        run_id = uuid4().hex
        db.execute("INSERT INTO routine_runs (id, routine_id, definition, trigger, status, scheduled_at, created_at) "
                   "VALUES (?, ?, ?, ?, 'queued', ?, ?)",
                   (run_id, routine["id"], json.dumps(routine), trigger, due, now))
        return db.execute("SELECT * FROM routine_runs WHERE id=?", (run_id,)).fetchone()

    def enqueue(self, project: Path, routine_id: str) -> dict:
        project = self._project(project)
        with self._db(write=True) as db:
            routine = _routine(self._get(db, project, routine_id))
            try:
                return _receipt(self._insert_run(db, routine, "manual", self.now()))
            except sqlite3.IntegrityError:
                raise RoutineError("该任务已在等待或运行中", 409) from None

    def runs(self, project: Path, routine_id: str) -> list[dict]:
        project = self._project(project)
        with self._db() as db:
            self._get(db, project, routine_id)
            rows = db.execute("SELECT * FROM routine_runs WHERE routine_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50",
                              (routine_id,)).fetchall()
        return [_receipt(row) for row in rows]

    def results(self, workspace: Path) -> list[dict]:
        is_project = workspace.parent.name == "projects"
        if is_project:
            self._project(workspace)
        scope = "routines.project" if is_project else "routines.company"
        with self._db() as db:
            rows = db.execute(f"SELECT routine_runs.* FROM routine_runs JOIN routines ON routine_id=routines.id "
                              f"WHERE {scope}=? AND status IN ('succeeded', 'failed') "
                              "ORDER BY finished_at DESC, routine_runs.rowid DESC LIMIT 100", (str(workspace),)).fetchall()
        return [_receipt(row) for row in rows]

    def _claim(self, now):
        with self._db(write=True) as db:
            # The process lock is held for the whole child lifetime. A running
            # row present at lock acquisition belongs to an interrupted worker.
            db.execute("UPDATE routine_runs SET status='failed', finished_at=?, error=? WHERE status='running'",
                       (now, "上次运行中断，请检查项目文件后重试"))
            run = db.execute("SELECT * FROM routine_runs WHERE status='queued' ORDER BY created_at, rowid LIMIT 1").fetchone()
            if not run:
                row = db.execute("SELECT * FROM routines WHERE state='active' AND next_due<=? ORDER BY next_due, id LIMIT 1",
                                 (now,)).fetchone()
                if not row:
                    return None
                routine = _routine(row)
                schedule = routine["schedule"]
                due = latest_occurrence(schedule, now) or routine["nextDueAt"]
                trigger = "recovery" if now - routine["nextDueAt"] >= 60_000 else "scheduled"
                run = self._insert_run(db, routine, trigger, now, due)
                next_due = next_occurrence(schedule, now)
                db.execute("UPDATE routines SET state=?, next_due=?, updated_at=? WHERE id=?",
                           ("active" if next_due is not None else "inactive", next_due, now, routine["id"]))
            db.execute("UPDATE routine_runs SET status='running', started_at=? WHERE id=?", (now, run["id"]))
            return run

    def _finish(self, run, status, *, result=None, error=None):
        with self._db(write=True) as db:
            db.execute("UPDATE routine_runs SET status=?, finished_at=?, result=?, error=? WHERE id=?",
                       (status, self.now(), result, error, run["id"]))

    async def run_one(self) -> bool:
        if not self._initialized:
            with self._db():
                pass  # Ensure the state directory exists before taking the worker lock.
        lock = FileLock(str(self.path) + ".lock")
        try:
            lock.acquire(timeout=0)
        except Timeout:
            return False
        try:
            run = self._claim(self.now())
            if not run:
                return False
            try:
                routine = json.loads(run["definition"])
                project = self._project(Path(routine["projectRoot"]))
                role = _role_prompt(project.parent.parent, routine["agent"])
                if self.runner:
                    output = await self.runner(project, routine, role)
                elif self.launcher and self.launcher.is_file():
                    output = await run_local_routine(self.launcher, project, routine, role)
                else:
                    raise RoutineError("本地调度器未就绪，请在支持调度的 AIOPC 桌面应用中运行")
                self._finish(run, "succeeded", result=output)
            except asyncio.CancelledError:
                self._finish(run, "failed", error="应用关闭，例行任务已中断")
                raise
            except TimeoutError:
                self._finish(run, "failed", error="本次运行超过 10 分钟")
            except (OSError, ValueError) as exc:
                self._finish(run, "failed", error=str(exc)[:2000])
            return True
        finally:
            lock.release()

    async def _loop(self):
        while True:
            try:
                if await self.run_one():
                    continue
            except Exception:
                logger.exception("本地例行任务检查失败")
            await asyncio.sleep(1)

    @asynccontextmanager
    async def lifespan(self, _app):
        worker = asyncio.create_task(self._loop())
        try:
            yield
        finally:
            worker.cancel()
            with suppress(asyncio.CancelledError):
                await worker
