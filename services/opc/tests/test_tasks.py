from concurrent.futures import ThreadPoolExecutor

import pytest

from aiopc.tasks import TaskError, TaskStore


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "company" / "projects" / "alpha"
    root.mkdir(parents=True)
    return root


@pytest.fixture
def tasks(project):
    return TaskStore(project)


def test_markdown_round_trip_and_manual_edits(tasks, project):
    task = tasks.create({"title": "发布准备", "description": "第一段\n\n---\n\n第二段", "assignee": "growth",
                         "deliverables": [{"kind": "publish", "path": "content/launch.md", "label": "首发文案"}]})
    path = project / "tasks" / f"{task['id']}.md"
    document = path.read_text(encoding="utf-8")
    assert document.startswith("---\n") and "\n\n第一段\n" in document
    path.write_text(document.replace("第二段", "手动修改"), encoding="utf-8")
    reopened = TaskStore(project).get(task["id"])
    assert reopened["description"].endswith("手动修改")
    assert reopened["deliverables"][0]["label"] == "首发文案"
    assert reopened["activity"][0]["action"] == "created"
    assert reopened["activity"][0]["actor"] == "user"


def test_authored_markdown_and_bad_file_do_not_break_board(tasks, project):
    directory = project / "tasks"
    directory.mkdir()
    (directory / "brief.md").write_text("---\ntitle: 产品简介\nstatus: todo\n---\n\n写完首页介绍。\n")
    (directory / "broken.md").write_text("---\ntitle: [\n---\n")
    result = tasks.list()
    assert result["items"][0]["id"] == "brief"
    assert result["items"][0]["description"] == "写完首页介绍。"
    assert result["issues"][0]["file"] == "broken.md"
    assert tasks.get("brief")["updatedAt"]


def test_dependencies_block_and_resume_and_activity_tracks_updates(tasks):
    design = tasks.create({"title": "设计"})
    launch = tasks.create({"title": "发布", "blockedBy": [design["id"]], "status": "in_progress"})
    assert launch["status"] == "blocked" and launch["requestedStatus"] == "in_progress"
    with pytest.raises(TaskError, match="依赖"):
        tasks.update(launch["id"], {"status": "done"})
    with pytest.raises(TaskError, match="循环"):
        tasks.update(design["id"], {"blockedBy": [launch["id"]]})
    tasks.update(design["id"], {"status": "done"})
    assert tasks.get(launch["id"])["status"] == "in_progress"
    completed = tasks.update(launch["id"], {"status": "done"}, actor="agent")
    assert completed["activity"][-1]["fields"] == ["status"]
    assert completed["activity"][-1]["actor"] == "agent"


def test_parent_graph_and_dependency_graph_can_cross_but_neither_can_loop(tasks):
    parent = tasks.create({"title": "项目启动"})
    child = tasks.create({"title": "准备物料", "parent": parent["id"]})
    assert tasks.update(parent["id"], {"blockedBy": [child["id"]]})["status"] == "blocked"
    with pytest.raises(TaskError, match="循环"):
        tasks.update(parent["id"], {"parent": child["id"]})


def test_claim_is_atomic_and_retries_are_idempotent(tasks):
    task = tasks.create({"title": "写稿"})
    def claim(role):
        try:
            return tasks.claim(task["id"], role)
        except TaskError as exc:
            assert exc.status == 409
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        wins = [winner for winner in pool.map(claim, ["growth", "design"]) if winner is not None]
    assert len(wins) == 1
    winner = wins[0]
    assert winner["status"] == "in_progress"
    assert tasks.claim(task["id"], winner["assignee"])["activity"] == winner["activity"]


def test_stale_update_and_invalid_reference_leave_source_intact(tasks, project):
    task = tasks.create({"title": "写稿"})
    tasks.update(task["id"], {"title": "草稿"})
    with pytest.raises(TaskError) as stale:
        tasks.update(task["id"], {"title": "新版"}, expected_updated_at=task["updatedAt"])
    assert stale.value.status == 409
    sibling = project.parent / "beta"
    sibling.mkdir()
    foreign = TaskStore(sibling).create({"title": "其他项目"})
    with pytest.raises(TaskError, match="当前项目"):
        tasks.update(task["id"], {"blockedBy": [foreign["id"]]})
    assert tasks.get(task["id"])["title"] == "草稿"


@pytest.mark.parametrize("path", ["../secret.md", "/private/file.md", "https://example.com/a.md", "assets\\..\\secret.md"])
def test_deliverable_path_must_be_project_relative(tasks, path):
    with pytest.raises(TaskError, match="交付物"):
        tasks.create({"title": "写稿", "deliverables": [{"kind": "file", "path": path}]})


def test_symlink_cannot_expose_another_project(tasks, project, tmp_path):
    external = tmp_path / "external"
    external.mkdir()
    (project / "tasks").symlink_to(external, target_is_directory=True)
    with pytest.raises(TaskError, match="任务目录"):
        tasks.create({"title": "写稿"})
    assert not list(external.iterdir())
    (project / "tasks").unlink()
    (project / "tasks").mkdir()
    (project / "tasks" / "outside.md").symlink_to(external / "outside.md")
    assert tasks.list()["issues"][0]["file"] == "outside.md"
    with pytest.raises(TaskError):
        tasks.get("outside")
    (project / "content").symlink_to(external, target_is_directory=True)
    with pytest.raises(TaskError, match="交付物"):
        tasks.create({"title": "写稿", "deliverables": [{"kind": "publish", "path": "content/outside.md"}]})
