"""Regression proofs for authoritative company roots and safe binding projections."""
import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient
from test_environment_pool import FakeProvider, setup_pool

from aiopc.authorized_workspaces import AuthorizedWorkspaces, WorkspaceForbidden
from aiopc.company import Company
from aiopc.sandbox import Sandboxes, pool_store
from aiopc.sandbox.environment import SandboxError
from aiopc.server import create_api
from aiopc.workspace_scope import WorkspaceScope


def test_http_company_root_named_under_projects_does_not_share_ancestor_pool(tmp_path, monkeypatch):
    a, b = tmp_path / 'projects' / 'A', tmp_path / 'projects' / 'B'
    a.mkdir(parents=True)
    b.mkdir()
    original = Sandboxes.__init__

    def initialize(self, *args, **kwargs):
        original(self, *args, **kwargs)
        self._providers['fake'] = FakeProvider()

    monkeypatch.setattr(Sandboxes, '__init__', initialize)
    api = TestClient(create_api(tmp_path / 'home', 'token', authorized_roots=[tmp_path, a, b]))
    api.headers['Authorization'] = 'Bearer token'
    created = api.post('/api/environments', params={'workspace': str(a)}, json={'name': 'A-only', 'provider': 'fake'})
    assert created.status_code == 200, created.text
    assert created.json()['company'] == str(a.resolve())
    other = api.get('/api/environments', params={'workspace': str(b)})
    assert other.json()['items'] == []
    assert api.get('/api/projects', params={'workspace': str(a)}).json()['company']['path'] == str(a.resolve())
    denied = api.post('/api/environments/' + created.json()['id'], params={'workspace': str(b)}, json={'action': 'destroy'})
    assert denied.status_code == 400


def test_mcp_scope_prefers_private_authorized_company_root_over_directory_name(tmp_path, monkeypatch):
    root = tmp_path / 'projects' / 'A'
    root.mkdir(parents=True)
    company = Company(root)
    company.create('inside')
    authorized = tmp_path / 'companies.json'
    authorized.write_text(json.dumps({'version': 1, 'roots': [str(root.resolve())]}))
    authorized.chmod(0o600)
    monkeypatch.setenv('AIOPC_AUTHORIZED_COMPANIES_FILE', str(authorized))
    scope = WorkspaceScope(tmp_path / 'home', root, lambda _home, path: SimpleNamespace(root=path))
    assert scope.company.root == root.resolve()
    with scope.use('inside') as selected:
        assert selected.root == root.resolve() / 'projects' / 'inside'
    with pytest.raises(WorkspaceForbidden):
        WorkspaceScope(tmp_path / 'home', tmp_path, lambda _home, path: SimpleNamespace(root=path))


def test_private_authorized_root_cannot_be_retargeted_by_symlink(tmp_path, monkeypatch):
    root, outside = tmp_path / 'company', tmp_path / 'outside'
    root.mkdir()
    outside.mkdir()
    authorized = tmp_path / 'companies.json'
    authorized.write_text(json.dumps({'version': 1, 'roots': [str(root.resolve())]}))
    authorized.chmod(0o600)
    monkeypatch.setenv('AIOPC_AUTHORIZED_COMPANIES_FILE', str(authorized))
    root.rename(root.with_name('old-company'))
    root.symlink_to(outside, target_is_directory=True)
    with pytest.raises(WorkspaceForbidden):
        AuthorizedWorkspaces().resolve(str(outside))


@pytest.mark.parametrize('operation', ['unbind', 'rebind', 'destroy'])
async def test_binding_mutations_reject_symlink_before_changing_registry(tmp_path, operation):
    company, alpha, beta, pool, provider = setup_pool(tmp_path)
    env = pool.create_environment(str(company.root), 'A', 'fake')
    await pool.bind(env['id'], alpha)
    before = pool.get(env['id'])
    outside = tmp_path / 'outside'
    outside.mkdir()
    original = Path(alpha)
    original.rename(original.with_name('old-alpha'))
    original.symlink_to(outside, target_is_directory=True)
    with pytest.raises((ValueError, SandboxError)):
        if operation == 'unbind':
            await pool.unbind(env['id'])
        elif operation == 'destroy':
            await pool.destroy_resource(env['id'])
        else:
            await pool.bind(env['id'], beta)
    assert pool.get(env['id']) == before
    assert provider.reset_calls == []
    assert not (outside / 'environments.json').exists()


def test_parallel_bind_projection_does_not_overwrite_newer_registry_snapshot(tmp_path, monkeypatch):
    company, alpha, _, pool, _ = setup_pool(tmp_path)
    one = pool.create_environment(str(company.root), 'one', 'fake')
    two = pool.create_environment(str(company.root), 'two', 'fake')
    paused, resume = threading.Event(), threading.Event()
    original = pool_store.atomic_json

    def write(path, value):
        if path.name == 'environments.json' and threading.current_thread().name == 'bind-one':
            paused.set()
            assert resume.wait(10)
        original(path, value)

    monkeypatch.setattr(pool_store, 'atomic_json', write)

    def bind(item, name):
        threading.current_thread().name = name
        asyncio.run(pool.bind(item['id'], alpha))

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(bind, one, 'bind-one')
        assert paused.wait(10)
        second = executor.submit(bind, two, 'bind-two')
        # While the old projection is paused, the second writer either waits on
        # the registry lock or finishes; both schedules must retain both bindings.
        threading.Event().wait(0.1)
        resume.set()
        first.result()
        second.result()
    projected = json.loads((Path(alpha) / 'environments.json').read_text())['environments']
    assert set(projected) == {one['id'], two['id']}


def test_legacy_migration_keeps_an_authorized_company_under_projects(tmp_path, monkeypatch):
    root = tmp_path / 'projects' / 'A'
    root.mkdir(parents=True)
    home = tmp_path / 'home'
    home.mkdir()
    authorized = tmp_path / 'companies.json'
    authorized.write_text(json.dumps({'version': 1, 'roots': [str(root.resolve())]}))
    authorized.chmod(0o600)
    monkeypatch.setenv('AIOPC_AUTHORIZED_COMPANIES_FILE', str(authorized))
    (home / 'sandbox.json').write_text(json.dumps({'projects': {str(root.resolve()): {
        'provider': 'local', 'state': {'container': 'preserved-container', 'volume': 'preserved-profile'}}}}))
    items = Sandboxes(home).list_environments(str(root))
    assert len(items) == 1
    assert items[0]['company'] == str(root.resolve())
    assert items[0]['state']['volume'] == 'preserved-profile'
