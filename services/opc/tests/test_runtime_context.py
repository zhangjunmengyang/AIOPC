import asyncio
import json

import httpx
import pytest

from aiopc.runtime_context import RuntimeContextError, RuntimeContextResolver, current_runtime_context, use_runtime_context


def setup(tmp_path):
    company = tmp_path / 'company'
    project = company / 'projects' / 'A'
    project.mkdir(parents=True)
    runtime = '5c1b07bd-2088-47c8-bcf0-1d8135d99e53'
    directory = tmp_path / 'runtime-context'
    directory.mkdir()
    discovery = directory / f'{runtime}.json'
    discovery.write_text(json.dumps({'url': 'http://127.0.0.1:1234/runtime/session-context', 'token': 'secret', 'runtimeId': runtime}))
    discovery.chmod(0o600)
    payload = {'runtimeId': runtime, 'sessionId': 'ses_one', 'company': str(company), 'projectId': 'proj:A', 'projectDirectory': str(project), 'ancestors': []}
    return runtime, discovery, payload


@pytest.mark.asyncio
async def test_meta_is_required_and_host_response_supplies_project(tmp_path):
    runtime, discovery, payload = setup(tmp_path)
    requests = []

    def handler(request):
        requests.append(request)
        assert request.headers['x-aiopc-runtime-token'] == 'secret'
        return httpx.Response(200, json=payload)

    resolver = RuntimeContextResolver(tmp_path, discovery_file=discovery, transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeContextError):
        await resolver.resolve({'sessionId': 'ses_one'})
    identity = await resolver.resolve({'ai.opencode/sessionID': 'ses_one'})
    assert identity.owner()['projectDirectory'] == payload['projectDirectory']
    assert identity.owner()['runtimeId'] == runtime
    assert len(requests) == 1
    with pytest.raises(RuntimeContextError, match='项目'):
        await resolver.resolve({'ai.opencode/sessionID': 'ses_one'}, project=str(tmp_path))


@pytest.mark.asyncio
async def test_http_runtime_selection_rejects_foreign_or_changed_response(tmp_path):
    runtime, discovery, payload = setup(tmp_path)
    resolver = RuntimeContextResolver(tmp_path, transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)))
    assert (await resolver.resolve_session('ses_one', runtime_id=runtime)).session_id == 'ses_one'
    with pytest.raises(RuntimeContextError):
        await resolver.resolve_session('ses_one', runtime_id='../escape')
    payload['sessionId'] = 'other'
    with pytest.raises(RuntimeContextError):
        await resolver.resolve_session('ses_one', runtime_id=runtime)
    payload['sessionId'] = 'ses_one'
    payload['projectDirectory'] = str(tmp_path)
    with pytest.raises(RuntimeContextError):
        await resolver.resolve_session('ses_one', runtime_id=runtime)
    discovery.chmod(0o644)
    with pytest.raises(RuntimeContextError):
        await resolver.resolve_session('ses_one', runtime_id=runtime)


@pytest.mark.asyncio
async def test_context_is_isolated_between_concurrent_tools_and_restores(tmp_path):
    _runtime, discovery, payload = setup(tmp_path)
    resolver = RuntimeContextResolver(tmp_path, discovery_file=discovery, transport=httpx.MockTransport(lambda request: httpx.Response(200, json={**payload, 'sessionId': json.loads(request.content)['sessionId']})))
    one = await resolver.resolve({'ai.opencode/sessionID': 'one'})
    two = await resolver.resolve({'ai.opencode/sessionID': 'two'})

    async def check(identity):
        with use_runtime_context(identity):
            await asyncio.sleep(0)
            assert current_runtime_context() is identity
    await asyncio.gather(check(one), check(two))
    with pytest.raises(RuntimeContextError):
        current_runtime_context()
