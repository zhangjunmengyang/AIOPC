import asyncio
from datetime import datetime

import pytest

from aiopc.routine_schedule import next_occurrence, parse_schedule
from aiopc.routines import LocalRoutines, RoutineError


def stamp(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


@pytest.fixture
def project(tmp_path):
    project = tmp_path / "company" / "projects" / "Alpha"
    project.mkdir(parents=True)
    return project


def draft(*, kind="daily", at=0):
    schedule = {"kind": kind, "timezone": "Asia/Shanghai"}
    schedule.update({"at": at} if kind == "once" else {"hour": 9, "minute": 0})
    return {"name": "每日简报", "instructions": "读取项目计划，写一份简报。", "schedule": schedule}


def test_schedule_matches_clock_form_and_dst():
    daily = parse_schedule({"kind": "daily", "timezone": "America/New_York", "hour": 2, "minute": 30})
    assert next_occurrence(daily, stamp("2026-03-08T00:00:00+00:00")) == stamp("2026-03-08T07:00:00+00:00")
    repeated = parse_schedule({"kind": "daily", "timezone": "America/New_York", "hour": 1, "minute": 30})
    first = stamp("2026-11-01T05:30:00+00:00")
    assert next_occurrence(repeated, first - 1) == first
    assert next_occurrence(repeated, first) == stamp("2026-11-02T06:30:00+00:00")
    interval = parse_schedule({"kind": "interval", "timezone": "Asia/Shanghai", "everyHours": 3,
                               "daysOfWeek": [1, 1], "startHour": 9, "endHour": 18})
    assert interval["daysOfWeek"] == [1]
    assert next_occurrence(interval, stamp("2026-11-16T07:00:00+00:00")) == stamp("2026-11-23T01:00:00+00:00")
    with pytest.raises(ValueError):
        parse_schedule({"kind": "calendar", "timezone": "Asia/Shanghai"})
    with pytest.raises(ValueError):
        parse_schedule({"kind": "daily", "timezone": "../UTC", "hour": 9, "minute": 0})


async def test_run_survives_service_restart_and_is_scoped(tmp_path, project):
    now = stamp("2026-11-12T00:00:00+00:00")
    due = stamp("2026-11-12T01:00:00+00:00")
    home = tmp_path / "local-data"
    company = project.parent.parent
    sibling = project.parent / "Beta"
    sibling.mkdir()
    role = company / ".opencode" / "agent" / "editor.md"
    role.parent.mkdir(parents=True)
    role.write_text("---\npermission: allow\n---\n核对项目内的来源。", encoding="utf-8")
    calls = []

    async def launcher(directory, routine, role_prompt):
        calls.append((directory, routine["agent"], role_prompt))
        return "简报完成。"

    first = LocalRoutines(home, now=lambda: now, runner=launcher)
    created = first.create(project, {**draft(), "agent": "editor"})
    assert created["nextDueAt"] == due
    assert first.list(sibling)["items"] == []
    assert first.list(project)["agents"] == ["editor"]
    with pytest.raises(RoutineError):
        first.update(sibling, created["id"], {"name": "跨项目编辑"})
    assert first.results(company) == []
    assert await first.run_one() is False

    now = stamp("2026-11-14T02:00:00+00:00")
    restarted = LocalRoutines(home, now=lambda: now, runner=launcher)
    assert await restarted.run_one()
    assert await restarted.run_one() is False
    assert calls == [(project.resolve(), "editor", "核对项目内的来源。")]
    assert restarted.list(project)["items"][0]["nextDueAt"] == stamp("2026-11-15T01:00:00+00:00")
    run, = restarted.results(company)
    assert (run["kind"], run["status"], run["trigger"], run["projectRoot"], run["result"]) == (
        "routine_run", "succeeded", "recovery", str(project.resolve()), "简报完成。")
    assert run["scheduledAt"] == stamp("2026-11-14T01:00:00+00:00")
    assert restarted.results(sibling) == []


async def test_manual_run_pause_failure_and_project_removed(tmp_path, project):
    now = stamp("2026-11-12T00:00:00+00:00")
    launches = []

    async def launcher(directory, routine, role_prompt):
        launches.append(directory)
        raise RoutineError("模拟失败")

    service = LocalRoutines(tmp_path / "local-data", now=lambda: now, runner=launcher)
    created = service.create(project, draft(kind="once", at=now + 1000))
    routine_id = created["id"]
    service.update(project, routine_id, {"state": "inactive"})
    now += 2000
    assert await service.run_one() is False
    assert service.enqueue(project, routine_id)["status"] == "queued"
    with pytest.raises(RoutineError, match="已在"):
        service.enqueue(project, routine_id)
    assert await service.run_one() is True
    run, = service.runs(project, routine_id)
    assert (run["status"], run["error"], run["trigger"]) == ("failed", "模拟失败", "manual")
    service.enqueue(project, routine_id)
    project.rmdir()
    assert await service.run_one() is True
    assert launches == [project.resolve()]
    assert all(run["status"] == "failed" for run in service.results(project.parent.parent))


async def test_active_one_time_schedule_is_finished_once(tmp_path, project):
    now = stamp("2026-11-12T00:00:00+00:00")

    async def launcher(directory, routine, role_prompt):
        return "ready"

    service = LocalRoutines(tmp_path / "local-data", now=lambda: now, runner=launcher)
    created = service.create(project, draft(kind="once", at=now + 1000))
    now += 1000
    assert await service.run_one()
    assert await service.run_one() is False
    assert service.list(project)["items"][0]["state"] == "inactive"
    assert service.runs(project, created["id"])[0]["trigger"] == "scheduled"


async def test_local_launcher_returns_agent_text_instead_of_raw_logs(tmp_path, project, monkeypatch):
    home = tmp_path / "local-data"
    monkeypatch.setenv("AIOPC_TOKEN", "http-service-only")
    monkeypatch.setenv("AIOPC_RUNTIME_CONTEXT_FILE", "/desktop-session-only")
    launcher = tmp_path / "fake-local-launcher"
    launcher.write_text(
        "#!/bin/sh\n"
        "test \"$PWD\" = " + repr(str(project.resolve())) + " || exit 3\n"
        "test -z \"$AIOPC_TOKEN\" && test -z \"$AIOPC_RUNTIME_CONTEXT_FILE\" || exit 5\n"
        "grep -q '读取项目计划' || exit 4\n"
        "echo '{\"type\":\"text\",\"part\":{\"text\":\"本地结果\"}}'\n",
        encoding="utf-8",
    )
    launcher.chmod(0o700)
    service = LocalRoutines(home, launcher=launcher)
    created = service.create(project, draft())
    service.enqueue(project, created["id"])
    assert await service.run_one()
    run, = service.runs(project, created["id"])
    assert run["result"] == "本地结果"
    assert run["status"] == "succeeded"


async def test_two_workers_cannot_start_the_same_run_and_recheck_authorization(tmp_path, project):
    entered, finish = asyncio.Event(), asyncio.Event()
    home = tmp_path / "local-data"
    authorized = True

    def authorize(path):
        if not authorized:
            raise RoutineError("公司已撤销授权", 403)
        return path

    async def runner(directory, routine, role):
        entered.set()
        await finish.wait()
        return "完成"

    service = LocalRoutines(home, authorize_project=authorize, runner=runner)
    duplicate = LocalRoutines(home, authorize_project=authorize, runner=runner)
    created = service.create(project, draft())
    service.enqueue(project, created["id"])
    executing = asyncio.create_task(service.run_one())
    await asyncio.wait_for(entered.wait(), timeout=2)
    assert await duplicate.run_one() is False
    finish.set()
    assert await executing is True
    service.enqueue(project, created["id"])
    authorized = False
    entered.clear()
    assert await service.run_one() is True
    assert not entered.is_set()
    assert [receipt["status"] for receipt in service.results(project.parent.parent)] == ["failed", "succeeded"]
