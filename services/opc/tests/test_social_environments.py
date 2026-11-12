from types import SimpleNamespace

import pytest

from aiopc.sandbox import SandboxError
from aiopc.sandbox.leases import LeaseManager
from aiopc.social.context import use_browser_context
from aiopc.social.review import RESOURCE, PublishReview
from aiopc.social.service import SocialError, SocialService


class Pools:
    def __init__(self, home, project):
        self.records = {key: {'id': key, 'company': str(project.parent.parent), 'boundProject': str(project), 'bindingRevision': 1, 'name': key} for key in ('env_a', 'env_b')}
        self.leases = LeaseManager(home, binding_resolver=self.get)

    def get(self, key):
        return self.records[key]

    def resolve(self, project, environment=''):
        if not environment:
            raise SandboxError('多个环境，请明确指定 environment')
        record = self.get(environment)
        if record['boundProject'] != project:
            raise SandboxError('环境不属于项目')
        return record

    async def ensure(self, project, environment=''):
        self.resolve(project, environment)
        return SimpleNamespace(cdp_url=environment)


class Browser:
    def __init__(self, environment):
        self.environment = environment
        self.calls = []

    async def account(self, platform):
        self.calls.append(('account', platform))
        return {'id': self.environment, 'name': self.environment}

    async def compose(self, platform, form, **payload):
        self.calls.append(('compose', payload))
        return {'page_url': 'https://example.test/draft'}


def setup(tmp_path):
    project = tmp_path / 'company' / 'projects' / 'A'
    project.mkdir(parents=True)
    home = tmp_path / 'home'
    pools = Pools(home, project)
    browsers = {key: Browser(key) for key in pools.records}
    service = SocialService(home, project, sandboxes=pools, browser_factory=browsers.__getitem__)
    owner = {'runtimeId': 'ui', 'sessionId': 'person', 'kind': 'human', 'company': str(project.parent.parent), 'projectDirectory': str(project)}
    return service, pools, browsers, owner


@pytest.mark.asyncio
async def test_accounts_and_checks_use_their_stored_environment(tmp_path):
    service, _pools, browsers, owner = setup(tmp_path)
    with use_browser_context(owner=owner):
        with pytest.raises(SocialError, match='多个'):
            await service.connect('xhs', check=True)
        a = await service.connect('xhs', check=True, environment='env_a')
        b = await service.connect('xhs', check=True, environment='env_b')
        assert a['account']['environment'] == 'env_a'
        assert b['account']['environment'] == 'env_b'
        assert a['account']['account_id'] != b['account']['account_id']
        result = await service.check_logins(max_age=-1)
        assert len(result['checked']) == 2
        assert all(item['logged_in'] for item in result['checked'])
        with use_browser_context('env_b'), pytest.raises(SocialError, match='环境'):
            await service.browser_for(service._account(a['account']['account_id']))
    assert len(browsers['env_a'].calls) == len(browsers['env_b'].calls) == 2


@pytest.mark.asyncio
async def test_real_browser_transport_requires_trusted_owner_and_login_state_is_scoped(tmp_path, monkeypatch):
    service, pools, browsers, owner = setup(tmp_path)
    owner = {**owner, 'kind': 'automation'}
    with pytest.raises(ValueError, match='可信'):
        await service.browser('env_a')
    from aiopc.social.login import Login
    async def no_account(platform):
        return None
    for browser in browsers.values():
        browser.account = no_account
    async def opened(login, url):
        return {'title': login.browser.environment_id}
    async def read(login, **kwargs):
        return {'title': login.browser.environment_id}
    async def qr(login):
        return 'qr'
    monkeypatch.setattr(Login, 'open', opened)
    monkeypatch.setattr(Login, 'settle', read)
    monkeypatch.setattr(Login, 'qr_code', qr)
    with use_browser_context(owner=owner):
        await service.login_open('xhs', environment='env_a')
        await service.login_open('xhs', environment='env_b')
        assert (await service.login_look(environment='env_a'))['title'] == 'env_a'
        assert pools.leases.status('env_a')['holder']['waitingForUser']
    with use_browser_context(owner={**owner, 'sessionId': 'other'}), pytest.raises(SocialError, match='登录页'):
        await service.login_look(environment='env_a')


@pytest.mark.asyncio
async def test_review_freezes_environment_and_binding_revision(tmp_path):
    service, pools, browsers, owner = setup(tmp_path)
    with use_browser_context(owner=owner):
        account = (await service.connect('x', check=True, environment='env_a'))['account']
        review = PublishReview(service)
        draft = review.prepare(account['account_id'], 'hello')
        assert draft['environment'] == 'env_a'
        assert draft['bindingRevision'] == 1
        pools.records['env_a']['bindingRevision'] = 2
        with pytest.raises(SocialError, match='环境'):
            await review.decide(draft['id'], draft['digest'], 'approve', app_action={'approved': True, 'resourceUri': RESOURCE})
        assert not any(call[0] == 'compose' for call in browsers['env_a'].calls)


@pytest.mark.asyncio
async def test_selected_environment_check_does_not_touch_other_account(tmp_path):
    service, _pools, browsers, owner = setup(tmp_path)
    with use_browser_context(owner=owner):
        await service.connect('xhs', check=True, environment='env_a')
        await service.connect('xhs', check=True, environment='env_b')
    with use_browser_context('env_a', owner=owner):
        result = await service.check_logins(max_age=-1)
    assert len(result['checked']) == 1
    assert len(browsers['env_a'].calls) == 2
    assert len(browsers['env_b'].calls) == 1


@pytest.mark.asyncio
async def test_http_human_account_operations_release_before_viewer_takeover(tmp_path):
    service, pools, _browsers, owner = setup(tmp_path)
    with use_browser_context('env_a', owner=owner):
        await service.connect('x', check=True)
    assert pools.leases.status('env_a')['holder'] is None


@pytest.mark.asyncio
async def test_switching_identity_invalidates_only_old_account_in_same_environment(tmp_path):
    service, _pools, browsers, owner = setup(tmp_path)
    identity = ['A']

    async def current_account(platform):
        return {'id': identity[0], 'name': identity[0]}
    browsers['env_a'].account = current_account
    with use_browser_context(owner=owner):
        first = (await service.connect('x', check=True, environment='env_a'))['account']
        other_environment = (await service.connect('x', check=True, environment='env_b'))['account']
        other_platform = (await service.connect('discord', check=True, environment='env_a'))['account']
        saved_routes = service.store.set_route(first['account_id'], 'x-api', {'username': 'A'})['routes']
        identity[0] = 'B'
        second = (await service.connect('x', check=True, environment='env_a'))['account']
        status = {item['account_id']: item['status'] for item in service.accounts()}
        assert status[first['account_id']] == 'needs_login'
        assert status[second['account_id']] == 'ready'
        assert status[other_environment['account_id']] == 'ready'
        assert status[other_platform['account_id']] == 'ready'
        assert service.store.get(first['account_id'])['routes'] == saved_routes
        identity[0] = 'A'
        restored = (await service.connect('x', check=True, environment='env_a'))['account']
        assert restored['account_id'] == first['account_id']
        assert service.describe(service.store.get(second['account_id']))['status'] == 'needs_login'
