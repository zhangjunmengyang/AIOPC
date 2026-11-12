import pytest
from test_environment_pool import setup_pool

from aiopc.sandbox.environment import ProjectKey, SandboxError
from aiopc.sandbox.leases import LeaseError


async def test_busy_environment_cannot_unbind_or_stop(tmp_path):
    company, alpha, _, pool, _ = setup_pool(tmp_path)
    env = pool.create_environment(str(company.root), '一', 'fake')
    env = await pool.bind(env['id'], alpha)
    owner = {'runtimeId': 'test', 'sessionId': 'first', 'company': str(company.root), 'projectDirectory': alpha}
    lease = pool.leases.acquire(env['id'], owner, env['bindingRevision'])
    with pytest.raises(LeaseError, match='使用'):
        await pool.unbind(env['id'])
    with pytest.raises(LeaseError, match='使用'):
        await pool.stop_resource(env['id'])
    pool.leases.release(env['id'], owner, lease['leaseId'])
    await pool.unbind(env['id'])
    assert pool.get(env['id'])['boundProject'] is None


async def test_reset_failure_preserves_binding_and_accounts(tmp_path):
    from aiopc.accounts import AccountStore
    company, alpha, beta, pool, provider = setup_pool(tmp_path)
    env = pool.create_environment(str(company.root), '一', 'fake')
    await pool.bind(env['id'], alpha)
    account = AccountStore(pool.home).upsert('xhs', {'id': 'x'}, project=alpha, environment=env['id'])
    await pool.unbind(env['id'])
    review = await pool.bind(env['id'], beta)
    async def fails(*args):
        raise SandboxError('清理失败')
    provider.reset = fails
    with pytest.raises(SandboxError, match='清理失败'):
        await pool.bind(env['id'], beta, confirmation=review['confirmation'])
    assert pool.get(env['id'])['lastProject'] == alpha
    assert pool.get(env['id'])['boundProject'] is None
    assert AccountStore(pool.home).get(account['id'])['environment'] == env['id']


async def test_local_reset_requires_successful_profile_deletion(tmp_path, monkeypatch):
    from aiopc.sandbox import local
    provider = local.LocalDockerProvider(tmp_path)
    calls = []
    async def docker(*args, **kwargs):
        calls.append(args)
        assert kwargs.get('check', True)
        if args[0] == 'ps':
            return 'old-container'
        if args[:2] == ('volume', 'ls'):
            return 'old-profile'
        if args[:2] == ('volume', 'rm'):
            raise SandboxError('profile busy')
        return ''
    monkeypatch.setattr(local, '_docker', docker)
    state = {'container': 'old-container', 'volume': 'old-profile', 'password': 'test'}
    with pytest.raises(SandboxError, match='profile busy'):
        await provider.reset(ProjectKey('env-a'), state)
    assert state['volume'] == 'old-profile'
    assert ('rm', '-f', 'old-container') in calls


async def test_manual_reset_fails_closed(tmp_path):
    from aiopc.sandbox.remote import ManualProvider
    with pytest.raises(SandboxError, match='清空'):
        await ManualProvider().reset(ProjectKey('env-a'), {'_secret': {'cdp_url': 'ws://external'}})


@pytest.mark.parametrize('provider_id,path', [('kernel','/profiles/profile-a'),('browserbase','/v1/contexts/profile-a'),('hyperbrowser','/api/profile/profile-a'),('anchor',None)])
async def test_remote_reset_deletes_profile_only_after_release(provider_id, path):
    from aiopc.sandbox.remote import REMOTE_CATALOG, RemoteProvider, fill
    provider = RemoteProvider(next(item for item in REMOTE_CATALOG if item.info.id == provider_id))
    calls = []
    async def request(call, context):
        calls.append((call.method, fill(call.path, context)))
        return {}
    provider._request = request
    key = ProjectKey('env-a')
    state = {'profile':'profile-a','session':'session-a','_secret':{'api_key':'test'}}
    await provider.reset(key, state)
    assert calls[-1] == ('DELETE', path or '/v1/profiles/' + key.slug)
    assert len(calls) == 2 and not state


async def test_remote_reset_does_not_forget_failed_cleanup():
    from aiopc.sandbox.remote import REMOTE_CATALOG, RemoteProvider
    provider = RemoteProvider(next(item for item in REMOTE_CATALOG if item.info.id == 'kernel'))
    async def request(*args):
        raise SandboxError('服务不可用')
    provider._request = request
    state = {'profile':'original','session':'session-a'}
    with pytest.raises(SandboxError, match='服务不可用'):
        await provider.reset(ProjectKey('env-a'), state)
    assert state['profile'] == 'original' and state['session'] == 'session-a'
