import hashlib
import json
from pathlib import Path

import pytest
from filelock import FileLock

from aiopc.media.video import MediaScopeError, VideoConfig, VideoService
from aiopc.server import create_server
from aiopc.workspace_migration import main

JOB = "vid_" + "1" * 24
OTHER = "vid_" + "2" * 24


@pytest.fixture
def folders(tmp_path):
    old, company, home = [tmp_path / name for name in ("old", "company", "instance")]
    for folder in (old, company, home):
        folder.mkdir()
    return old, company, home


def run(folders, *flags, project="测试项目"):
    old, company, home = folders
    return main(["--source", str(old), "--company", str(company), "--project", project, "--video-home", str(home), *flags])


def write(root, name, data):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def job_record(home, job_id=JOB, **fields):
    record = {"id": job_id, "model": "test", "status": "succeeded", "created_at": 42,
              "task_id": "task-42", "video_url": "https://example.test/?token=private", **fields}
    return write(home, f"media/video/jobs/{job_id}.json", json.dumps(record).encode())


def tool_data(result):
    if isinstance(result, tuple):
        result = result[0]
    return [json.loads(item.text) for item in result]


async def test_dry_run_apply_and_repeat(folders, capsys):
    old, company, home = folders
    selected = {
        "CONTEXT.md": b"# Old brief\n", "brand.md": b"# Brand\n", "MEMORY.md": b"# History\n",
        "decisions.md": b"# Decisions\n", "marketing-plan.md": b"# Plan\n", "STATE.md": b"# State\n",
        "knowledge/notes/a.pdf": b"PDF", "knowledge/README.md": b"# Original knowledge",
        "content-rules/editorial.md": b"# Guidelines", "assets/generated/clip.mp4": b"video",
        "content/article.md": b"draft", "accounts/x.md": b"voice",
        "social/log.jsonl": b'{"action":"published","url":"https://example.test/post"}\n',
        "research/interview.md": b"notes", "campaigns/launch/brief.md": b"launch",
    }
    for name, data in selected.items():
        write(old, name, data)
    write(old, ".opencode/skills/sample/SKILL.md", b"private")
    write(old, "social/token.json", b"private")
    (old / "assets" / "empty").mkdir()
    assert run(folders, "--dry-run") == 0
    preview = json.loads(capsys.readouterr().out)
    assert preview["mode"] == "dry-run"
    assert {item["path"] for item in preview["files"]} == selected.keys()
    assert not list(company.iterdir())
    assert not list(home.iterdir())

    assert run(folders) == 0
    capsys.readouterr()
    target = company / "projects" / "测试项目"
    assert (company / ".git").exists()
    assert (target / "assets" / "empty").is_dir()
    for name, data in selected.items():
        assert (target / name).read_bytes() == data == (old / name).read_bytes()
    assert not (target / ".opencode").exists()
    assert not (target / "social" / "token.json").exists()
    mcp = create_server(home, company)
    brief = tool_data(await mcp.call_tool("get_project_brief", {"project": "测试项目"}))[0]
    assert brief["context"] == selected["CONTEXT.md"].decode()
    history = tool_data(await mcp.call_tool("social_history", {"project": "测试项目"}))
    assert history == [json.loads(selected["social/log.jsonl"])]
    before = {name: (target / name).stat().st_mtime_ns for name in selected}
    assert run(folders) == 0
    repeated = json.loads(capsys.readouterr().out)
    assert repeated["directories"] == []
    assert repeated["initialize"] == []
    assert {item["action"] for item in repeated["files"]} == {"unchanged"}
    assert {name: (target / name).stat().st_mtime_ns for name in selected} == before


def test_existing_project_gets_only_missing_files(folders):
    old, company, _ = folders
    write(old, "assets/logo.png", b"logo")
    target = company / "projects" / "测试项目"
    brief = write(target, "CONTEXT.md", b"# Current project")
    assert run(folders) == 0
    assert brief.read_bytes() == b"# Current project"
    assert (target / "brand.md").is_file()
    assert (target / "assets" / "logo.png").read_bytes() == b"logo"


@pytest.mark.parametrize("conflict", ["different", "source_link", "dest_link", "parent_link", "blocked_skeleton"])
def test_conflicts_stop_before_copying(folders, conflict):
    old, company, home = folders
    write(old, "CONTEXT.md", b"# Original")
    logo = write(old, "assets/logo.png", b"logo")
    outside = write(home, "logo.png", b"external")
    target = company / "projects" / "测试项目"
    target.mkdir(parents=True)
    if conflict == "different":
        write(target, "assets/logo.png", b"another logo")
    elif conflict == "source_link":
        logo.unlink()
        logo.symlink_to(outside)
    elif conflict == "dest_link":
        (target / "assets").mkdir()
        (target / "assets" / "logo.png").symlink_to(outside)
    elif conflict == "parent_link":
        (target / "assets").symlink_to(home, target_is_directory=True)
    else:
        (target / "MEMORY.md").mkdir()
    assert run(folders) == 1
    assert not (company / ".git").exists()
    assert not (target / "CONTEXT.md").exists()
    assert outside.read_bytes() == b"external"


def test_rejects_in_place_and_invalid_project_names(folders):
    old, company, home = folders
    write(old, "knowledge/private.md", b"private")
    assert run((old, old, home)) == 1
    assert run(folders, project="../outside") == 1
    assert not (old / "projects").exists()
    assert not list(company.iterdir())


async def test_video_requires_selection_and_keeps_id_and_original(folders, capsys, monkeypatch):
    old, company, home = folders
    cache = write(home, f"media/video/files/{JOB}.mp4", b"rendered video")
    job = job_record(home, path=str(cache), mime="video/mp4", bytes=14)
    original = job.read_bytes()
    other = job_record(home, OTHER, workspace=str(old / "unrelated"))
    other_original = other.read_bytes()
    target = company / "projects" / "测试项目"

    assert run(folders, "--dry-run") == 0
    preview = capsys.readouterr().out
    assert JOB in preview and "token=private" not in preview
    assert run(folders) == 0
    assert job.read_bytes() == original
    assert run(folders, "--dry-run", "--video-job", JOB) == 0
    assert job.read_bytes() == original
    assert not (job.parent.parent / "legacy-jobs").exists()
    assert run(folders, "--video-job", JOB) == 0

    backup = job.parent.parent / "legacy-jobs" / job.name
    assert backup.read_bytes() == original
    assert backup.stat().st_mode & 0o777 == 0o600
    assert job.stat().st_mode & 0o777 == 0o600
    assert other.read_bytes() == other_original
    assert cache.read_bytes() == b"rendered video"
    config = VideoConfig("https://example.test/contents/generations/tasks", "test-key", "test")
    monkeypatch.setattr(VideoConfig, "from_env", classmethod(lambda cls: config))
    videos = VideoService(home, workspace=target, config=config)
    migrated = videos.get(JOB)
    assert migrated["id"] == JOB
    assert Path(migrated["path"]).read_bytes() == cache.read_bytes()
    assert Path(migrated["path"]) == target / "assets" / "generated" / cache.name
    assert [record["id"] for record in videos.list_jobs()] == [JOB]
    mcp = create_server(home, company)
    result = tool_data(await mcp.call_tool("download_video", {"job_id": JOB, "project": "测试项目"}))[0]
    assert result["path"] == migrated["path"]
    with pytest.raises(MediaScopeError):
        VideoService(home, workspace=company, config=config).get(JOB)

    capsys.readouterr()
    assert run(folders, "--video-job", JOB) == 0
    assert json.loads(capsys.readouterr().out)["video_jobs"] == [{"id": JOB, "action": "unchanged"}]
    assert run(folders, "--video-job", JOB, project="另一个项目") == 1
    assert not (company / "projects" / "另一个项目").exists()
    assert backup.read_bytes() == original


def test_rejects_foreign_video_paths_and_owned_jobs(folders):
    _, company, home = folders
    private = write(company, "knowledge/private.mp4", b"another project's video")
    job = job_record(home, path=str(private))
    other = job_record(home, OTHER, workspace=str(company / "projects" / "Other"))
    original, other_original = job.read_bytes(), other.read_bytes()
    assert run(folders, "--video-job", JOB) == 1
    assert run(folders, "--video-job", OTHER) == 1
    assert run(folders, "--video-job", "../../x") == 1
    assert not (company / "projects").exists()
    assert job.read_bytes() == original
    assert other.read_bytes() == other_original


def test_video_lock_prevents_changing_active_record(folders):
    _, company, home = folders
    job = job_record(home, status="running")
    original = job.read_bytes()
    with FileLock(job.with_suffix(".lock")):
        assert run(folders, "--video-job", JOB) == 1
    assert job.read_bytes() == original
    assert not (company / "projects").exists()


def test_video_can_resume_after_backup_written(folders):
    _, company, home = folders
    job = job_record(home, status="running")
    backup = write(home, f"media/video/legacy-jobs/{job.name}", job.read_bytes())
    backup.chmod(0o600)
    assert run(folders, "--video-job", JOB) == 0
    assert json.loads(job.read_bytes())["workspace"] == str(company / "projects" / "测试项目")
    assert "workspace" not in json.loads(backup.read_bytes())


def test_invalid_publish_log_is_rejected(folders):
    old, company, _ = folders
    write(old, "social/log.jsonl", b'{"action":"published"}\ntruncated')
    assert run(folders) == 1
    assert not list(company.iterdir())


async def test_retrying_migrated_video_request_does_not_resubmit(folders, monkeypatch):
    _, company, home = folders
    request_id = "legacy-request"
    job_id = "vid_" + hashlib.sha256(request_id.encode()).hexdigest()[:24]
    prompt = "test video"
    fingerprint = hashlib.sha256(json.dumps([prompt, None, {}, "test"], sort_keys=True).encode()).hexdigest()
    job_record(home, job_id, status="queued", fingerprint=fingerprint)
    assert run(folders, "--video-job", job_id) == 0

    submitted = []

    async def request(self, method, **kwargs):
        submitted.append(method)
        return {"id": "new-task"}

    monkeypatch.setattr(VideoService, "_request", request)
    config = VideoConfig("https://example.test/contents/generations/tasks", "test-key", "test")
    migrated = VideoService(home, workspace=company / "projects" / "测试项目", config=config)
    assert (await migrated.create(prompt, request_id=request_id))["id"] == job_id
    assert not submitted

    assert run(folders, project="另一个项目") == 0
    other = VideoService(home, workspace=company / "projects" / "另一个项目", config=config)
    assert (await other.create(prompt, request_id=request_id))["id"] != job_id
    assert submitted == ["POST"]
