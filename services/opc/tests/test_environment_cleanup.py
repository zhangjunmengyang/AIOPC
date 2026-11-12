"""A deleted native session must still finish an already admitted browser operation."""
from uuid import uuid4

import pytest
from starlette.testclient import TestClient
from test_environment_pool import FakeProvider

from aiopc.company import Company
from aiopc.runtime_context import RuntimeContextError, RuntimeContextResolver
from aiopc.sandbox import Sandboxes
from aiopc.server import create_api


@pytest.fixture
def cleanup_fixture(tmp_path, monkeypatch):
    company = Company(tmp_path / 'company')
    company.root.mkdir()
    project = company.create('alpha')['path']
    home = tmp_path / 'home'
    original = Sandboxes.__init__

    def initialize(self, *args, **kwargs):
        original(self, *args, **kwargs)
        self._providers['fake'] = FakeProvider()

    async def missing(*_args, **_kwargs):
        raise RuntimeContextError('native session was deleted')

    monkeypatch.setattr(Sandboxes, '__init__', initialize)
    monkeypatch.setattr(RuntimeContextResolver, 'resolve_session', missing)
    api = TestClient(create_api(home, 'token', authorized_roots=[company.root]))
    api.headers['Authorization'] = 'Bearer token'
    env = api.post('/api/environments', params={'workspace': str(company.root)}, json={'name': 'one', 'provider': 'fake'}).json()
    bound = api.post('/api/environments/' + env['id'], params={'workspace': str(company.root)}, json={'action': 'bind', 'project': project}).json()
    owner = {'runtimeId': str(uuid4()), 'sessionId': 'ses_deleted', 'company': str(company.root),
             'projectDirectory': project, 'kind': 'automation', 'label': 'Deleted session'}
    return api, Sandboxes(home).leases, env['id'], bound['bindingRevision'], owner


def call(api, owner, env, revision, action, **data):
    return api.post('/api/environment/lease', params={'workspace': owner['projectDirectory'], 'environment': env},
                    json={'action': action, 'runtimeId': owner['runtimeId'], 'sessionId': owner['sessionId'],
                          'bindingRevision': revision, **data})


def test_deleted_session_ends_existing_operation_after_lifecycle_release(cleanup_fixture):
    api, leases, env, revision, owner = cleanup_fixture
    acquired = leases.acquire(env, owner, revision)
    operation = str(uuid4())
    leases.begin_operation(env, owner, acquired['leaseId'], revision, operation)
    leases.release_runtime(owner['runtimeId'], session_id=owner['sessionId'], reason='deleted')
    result = call(api, owner, env, revision, 'end', leaseId=acquired['leaseId'], operationId=operation)
    assert result.status_code == 200, result.text
    assert result.json()['ended'] is True
    next_owner = {**owner, 'sessionId': 'ses_next'}
    assert leases.acquire(env, next_owner, revision)['state'] == 'granted'


def test_cleanup_tokens_cannot_end_another_sessions_operation(cleanup_fixture):
    api, leases, env, revision, owner = cleanup_fixture
    acquired = leases.acquire(env, owner, revision)
    operation = str(uuid4())
    leases.begin_operation(env, owner, acquired['leaseId'], revision, operation)
    leases.release_runtime(owner['runtimeId'], session_id=owner['sessionId'], reason='deleted')
    for forged in [{**owner, 'sessionId': 'ses_other'}, {**owner, 'runtimeId': str(uuid4())}]:
        result = call(api, forged, env, revision, 'end', leaseId=acquired['leaseId'], operationId=operation)
        assert result.status_code == 409, result.text
    result = call(api, owner, env, revision, 'end', leaseId=acquired['leaseId'], operationId='wrong-token')
    assert result.status_code == 409, result.text
    assert call(api, owner, env, revision, 'end', leaseId=acquired['leaseId'], operationId=operation).json()['ended'] is True


def test_deleted_waiter_can_cancel_only_its_own_queue_entry(cleanup_fixture):
    api, leases, env, revision, owner = cleanup_fixture
    leases.acquire(env, {**owner, 'sessionId': 'ses_holder'}, revision)
    queued = leases.acquire(env, owner, revision)
    assert queued['state'] == 'queued'
    rejected = call(api, {**owner, 'sessionId': 'ses_other'}, env, revision, 'cancel', requestId=queued['requestId'])
    assert rejected.status_code == 409, rejected.text
    result = call(api, owner, env, revision, 'cancel', requestId=queued['requestId'])
    assert result.status_code == 200, result.text
    assert result.json()['cancelled'] is True
    assert leases.status(env)['queue'] == []
