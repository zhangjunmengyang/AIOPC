import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event

from aiopc.sandbox import Sandboxes, pool_store


def test_legacy_sandbox_migration_writes_the_project_binding_manifest(tmp_path):
    company = tmp_path / "company"
    project = company / "projects" / "alpha"
    project.mkdir(parents=True)
    home = tmp_path / "home"
    home.mkdir()
    (home / "sandbox.json").write_text(
        json.dumps({"provider": "local", "projects": {str(project): {"provider": "local", "state": {}}}}),
        encoding="utf-8",
    )

    (environment,) = Sandboxes(home).list_environments(str(company))

    assert environment["boundProject"] == str(project)
    manifest = json.loads((project / "environments.json").read_text(encoding="utf-8"))
    assert manifest == {"schemaVersion": 1, "environments": [environment["id"]]}


def test_parallel_binds_keep_the_project_manifest_in_sync(tmp_path, monkeypatch):
    company = tmp_path / "company"
    project = company / "projects" / "alpha"
    project.mkdir(parents=True)
    home = tmp_path / "home"
    first_pool, second_pool = Sandboxes(home), Sandboxes(home)
    first = first_pool.create_environment(str(company), "主环境")["id"]
    second = second_pool.create_environment(str(company), "备用环境")["id"]
    manifest = project / "environments.json"
    first_snapshot_ready = Event()
    second_bind_started = Event()
    second_bind_finished = Event()
    atomic_json = pool_store.atomic_json

    def delay_first_snapshot(path, data):
        if path == manifest and data["environments"] == [first]:
            first_snapshot_ready.set()
            assert second_bind_started.wait(timeout=5)
            # A correctly serialized bind cannot finish until this snapshot is written.
            second_bind_finished.wait(timeout=1)
        atomic_json(path, data)

    def bind_second():
        second_bind_started.set()
        try:
            return asyncio.run(second_pool.bind(second, str(project)))
        finally:
            second_bind_finished.set()

    monkeypatch.setattr(pool_store, "atomic_json", delay_first_snapshot)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first_bind = executor.submit(lambda: asyncio.run(first_pool.bind(first, str(project))))
        assert first_snapshot_ready.wait(timeout=5)
        second_bind = executor.submit(bind_second)
        assert first_bind.result(timeout=10)["boundProject"] == str(project)
        assert second_bind.result(timeout=10)["boundProject"] == str(project)

    bindings = json.loads(manifest.read_text(encoding="utf-8"))
    assert bindings == {"schemaVersion": 1, "environments": sorted([first, second])}
