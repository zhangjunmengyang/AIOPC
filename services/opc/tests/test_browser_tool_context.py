from types import SimpleNamespace

import pytest

from aiopc.company import Company
from aiopc.runtime_context import RuntimeIdentity
from aiopc.server import create_server
from aiopc.social.service import SocialService


async def test_browser_tool_requires_native_context_not_argument_session_id(tmp_path):
    root = tmp_path / 'company'
    root.mkdir()
    Company(root).create('a')
    server = create_server(tmp_path / 'home', root)
    tools = {item.name:item for item in await server.list_tools()}
    assert 'ctx' not in tools['login_open'].inputSchema['properties']
    assert 'sessionId' not in tools['login_open'].inputSchema['properties']
    with pytest.raises(Exception, match='会话|可信|context'):
        await server.call_tool('login_open', {'platform':'xhs', 'project':'a'})


async def test_trusted_session_supplies_default_project_and_rejects_mismatch(tmp_path, monkeypatch):
    from aiopc.runtime_context import RuntimeContextError, RuntimeContextResolver, current_runtime_context
    root = tmp_path / 'company'
    root.mkdir()
    company = Company(root)
    a = company.create('a')['path']
    b = company.create('b')['path']
    identity = RuntimeIdentity('runtime', 'one', root.resolve(), 'proj:a', company.resolve_project('a'), 'one')
    async def resolve(self, meta, project=''):
        if project and project != a:
            raise RuntimeContextError('工具项目与会话所属项目不一致')
        return identity
    monkeypatch.setattr(RuntimeContextResolver, 'resolve', resolve)
    async def login(self, platform, **kwargs):
        assert self.project_path == a
        assert current_runtime_context() is identity
        return {'status':'test-only'}
    monkeypatch.setattr(SocialService, 'login_open', login)
    server = create_server(tmp_path / 'home', root)
    invoke = server._tool_manager.get_tool('login_open').fn
    ctx = SimpleNamespace(request_context=SimpleNamespace(meta={'ai.opencode/sessionID':'one'}))
    assert (await invoke(platform='xhs', ctx=ctx))['status'] == 'test-only'
    with pytest.raises(ValueError, match='项目'):
        await invoke(platform='xhs', project=b, ctx=ctx)
