
import pytest
from starlette.testclient import TestClient
from test_environment_pool import FakeProvider

from aiopc.company import Company
from aiopc.sandbox import Sandboxes
from aiopc.server import create_api


@pytest.fixture
def setup(tmp_path, monkeypatch):
    company = Company(tmp_path / 'company')
    company.root.mkdir()
    company.create('alpha')
    other = tmp_path / 'unopened'
    other.mkdir()
    home = tmp_path / 'home'
    original = Sandboxes.__init__
    def initialize(self, *args, **kwargs):
        original(self, *args, **kwargs)
        self._providers['fake'] = FakeProvider()
    monkeypatch.setattr(Sandboxes, '__init__', initialize)
    api = TestClient(create_api(home, 'token', authorized_roots=[company.root]))
    api.headers['Authorization'] = 'Bearer token'
    return api, company, other, home


def test_only_registered_company_and_direct_projects_are_served(setup):
    api, company, other, _ = setup
    for path in [other, company.root / 'assets', company.resolve_project('alpha') / 'assets']:
        path.mkdir(exist_ok=True)
        result = api.get('/api/space', params={'workspace': str(path)})
        assert result.status_code == 403
    assert api.get('/api/projects', params={'workspace': str(company.root)}).status_code == 200
    assert api.get('/api/project', params={'workspace': str(company.resolve_project('alpha'))}).status_code == 200


def test_missing_authorized_roots_fails_closed(tmp_path):
    api = TestClient(create_api(tmp_path / 'home', 'token'))
    response = api.get('/api/projects', params={'workspace': str(tmp_path)}, headers={'Authorization': 'Bearer token'})
    assert response.status_code == 403


def test_pool_http_bind_selection_leases_and_no_internal_state(setup):
    api, company, _, home = setup
    root = {'workspace': str(company.root)}
    project = company.resolve_project('alpha')
    ids = []
    for name in ['主', '副']:
        response = api.post('/api/environments', params=root, json={'name': name, 'provider': 'fake'})
        assert response.status_code == 200, response.text
        env = response.json()
        ids.append(env['id'])
        assert 'state' not in env
        response = api.post('/api/environments/' + env['id'], params=root, json={'action': 'bind', 'project': str(project)})
        assert response.status_code == 200, response.text
    assert len(api.get('/api/environments', params=root).json()['items']) == 2
    assert api.post('/api/environment', params={'workspace': str(project)}, json={'action': 'start'}).status_code == 400
    selection = {'workspace': str(project), 'environment': ids[0]}
    started = api.post('/api/environment', params=selection, json={'action': 'start'})
    assert started.status_code == 200 and started.json()['id'] == ids[0]
    revision = started.json()['bindingRevision']
    lease = api.post('/api/environment/lease', params=selection, json={'action': 'acquire', 'manual': True, 'sessionId': 'view-1', 'bindingRevision': revision})
    assert lease.status_code == 200, lease.text
    assert lease.json()['state'] == 'granted'
    busy = api.post('/api/environments/' + ids[0], params=root, json={'action': 'unbind'})
    assert busy.status_code == 409, busy.text
    api.post('/api/environment/lease', params=selection, json={'action': 'release', 'manual': True, 'sessionId': 'view-1', 'bindingRevision': revision, 'leaseId': lease.json()['leaseId']})
    assert api.post('/api/environments/' + ids[0], params=root, json={'action': 'unbind'}).status_code == 200
    assert Sandboxes(home).get(ids[0])['boundProject'] is None


def test_automation_owner_cannot_be_forged_in_body(setup):
    api, company, _, _ = setup
    env = api.post('/api/environments', params={'workspace': str(company.root)}, json={'name': '一', 'provider': 'fake'}).json()
    api.post('/api/environments/' + env['id'], params={'workspace': str(company.root)}, json={'action': 'bind', 'project': 'alpha'})
    result = api.post('/api/environment/lease', params={'workspace': str(company.resolve_project('alpha')), 'environment': env['id']},
                      json={'action': 'acquire', 'bindingRevision': 1, 'sessionId': 'forged', 'owner': {'kind': 'human'}})
    assert result.status_code == 400 and result.json()['code'] == 'runtime_context_required'
