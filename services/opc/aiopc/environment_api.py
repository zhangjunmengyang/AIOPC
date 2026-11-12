"""HTTP resource-pool and shared browser-lease endpoints."""
from __future__ import annotations

import secrets
import uuid
from pathlib import Path

from aiopc.runtime_context import RuntimeContextResolver
from aiopc.sandbox import Sandboxes
from aiopc.sandbox.leases import LeaseError


class EnvironmentRoutes:
    def __init__(self, home, workspace_of, respond, body):
        self.home = Path(home)
        self.workspace_of, self.respond, self.body = workspace_of, respond, body
        self.pool = Sandboxes(self.home)
        self.resolver = RuntimeContextResolver(self.home)

    def selected(self, request):
        workspace = self.workspace_of(request)
        env_id = request.query_params.get('environment', '')
        if not env_id:
            return workspace, self.pool.resolve(str(workspace.root))
        record = self.pool.get(env_id)
        company = workspace.company
        if record['company'] != str(company.root):
            raise ValueError('环境不属于当前公司')
        # The company resource page can view an unbound resource. A project page
        # and every automation operation require the actual project binding.
        if workspace.root != company.root:
            self.pool.resolve(str(workspace.root), env_id)
        return workspace, record

    async def collection(self, request):
        company = self.workspace_of(request).company
        if request.method == 'POST':
            data = await self.body(request)
            item = self.pool.create_environment(str(company.root), data.get('name', ''), data.get('provider', 'local'), data.get('fields'))
            return self.respond(await self.pool.describe_environment(item['id']))
        records = self.pool.list_environments(str(company.root))
        return self.respond({'company': company.describe(), 'items': [await self.pool.describe_environment(item['id']) for item in records],
                             'providers': await self.pool.describe_providers()})

    async def resource(self, request):
        company = self.workspace_of(request).company
        record = self.pool.get(request.path_params['environment_id'])
        if record['company'] != str(company.root):
            raise ValueError('环境不属于当前公司')
        env_id = record['id']
        data = await self.body(request)
        action = data.get('action')
        if action == 'bind':
            result = await self.pool.bind(env_id, data.get('project', ''), confirmation=data.get('confirmation', ''))
            if result.get('requires_confirmation'):
                return self.respond(result, 409)
        elif action == 'unbind':
            await self.pool.unbind(env_id)
        elif action == 'start':
            await self.pool.start_resource(env_id)
        elif action == 'stop':
            await self.pool.stop_resource(env_id)
        elif action == 'destroy':
            return self.respond(await self.pool.destroy_resource(env_id))
        else:
            raise ValueError('不认识的环境操作')
        return self.respond(await self.pool.describe_environment(env_id))

    async def environment(self, request):
        if request.method == 'POST':
            data = await self.body(request)
            if data.get('action') == 'install-engine':
                self.workspace_of(request)
                from aiopc.sandbox import install_engine
                return self.respond(await install_engine(data.get('engine_name') or 'orbstack'))
        else:
            data = {}
        _workspace, record = self.selected(request)
        action = data.get('action', 'start')
        if request.method == 'POST':
            if action == 'start':
                await self.pool.start_resource(record['id'])
            elif action == 'stop':
                await self.pool.stop_resource(record['id'])
            elif action == 'destroy':
                return self.respond(await self.pool.destroy_resource(record['id']))
            else:
                raise ValueError('请从公司环境资源池选择环境')
        return self.respond({**await self.pool.describe_environment(record['id']), 'providers': await self.pool.describe_providers()})

    async def lease(self, request):
        workspace, record = self.selected(request)
        env_id = record['id']
        manager = self.pool.leases
        if request.method == 'GET':
            return self.respond(manager.status(env_id))
        data = await self.body(request)
        action = data.get('action')
        if data.get('manual') is True:
            session_id = data.get('sessionId')
            if not isinstance(session_id, str) or not session_id or len(session_id) > 256:
                raise ValueError('人工接管缺少页面标识')
            owner = {'runtimeId': 'desktop-ui', 'sessionId': session_id, 'company': record['company'],
                     'projectDirectory': record['boundProject'] or record['company'], 'kind': 'human', 'label': '你'}
        elif action in {'end', 'cancel'}:
            owner = manager.cleanup_owner(env_id, runtime_id=data.get('runtimeId'), session_id=data.get('sessionId'),
                                          action=action, lease_id=data.get('leaseId', ''),
                                          operation_id=data.get('operationId', ''), request_id=data.get('requestId', ''))
            if Path(owner['company']).resolve() != Path(record['company']).resolve() or Path(owner['projectDirectory']).resolve() != workspace.root:
                raise ValueError('浏览器清理请求与原操作所属项目不一致')
        else:
            identity = await self.resolver.resolve_session(data.get('sessionId'), runtime_id=data.get('runtimeId'))
            if identity.project_directory != workspace.root:
                raise ValueError('浏览器请求与会话所属项目不一致')
            owner = identity.owner()
        action = data.get('action')
        revision = data.get('bindingRevision')
        if revision != record['bindingRevision']:
            raise LeaseError('环境绑定已经变化，请重新选择环境', 'binding_changed')
        lease = data.get('leaseId', '')
        if action == 'acquire':
            result = manager.acquire(env_id, owner, revision, request_id=data.get('requestId'))
        elif action == 'begin':
            result = manager.begin_operation(env_id, owner, lease, revision, data.get('operationId'))
        elif action == 'end':
            result = {'ended': manager.end_operation(env_id, owner, lease, data.get('operationId'))}
        elif action == 'heartbeat':
            result = manager.heartbeat(env_id, owner, lease, operation_id=data.get('operationId'), activity=data.get('activity') is True)
        elif action == 'wait':
            result = manager.wait_for_user(env_id, owner, lease)
        elif action == 'release':
            result = {'released': manager.release(env_id, owner, lease)}
        elif action == 'cancel':
            result = {'cancelled': manager.cancel(env_id, owner, data.get('requestId'))}
        else:
            raise ValueError('不认识的租约操作')
        return self.respond(result)

    async def release_runtime(self, request):
        data = await self.body(request)
        runtime_id = data.get('runtimeId')
        try:
            if str(uuid.UUID(runtime_id)) != runtime_id:
                raise ValueError
        except (ValueError, TypeError, AttributeError):
            raise ValueError('运行时标识无效') from None
        discovery = self.resolver._discovery(self.home / 'runtime-context' / (runtime_id + '.json'))
        if discovery['runtimeId'] != runtime_id or not secrets.compare_digest(request.headers.get('x-aiopc-runtime-token', ''), discovery['token']):
            return self.respond({'error': 'unauthorized'}, 401)
        reason = data.get('reason')
        if reason not in {'turn_end', 'abort', 'deleted', 'runtime_stop'}:
            raise ValueError('无效的会话结束原因')
        session = data.get('sessionId')
        if reason != 'runtime_stop' and (not isinstance(session, str) or not session):
            raise ValueError('缺少会话标识')
        result = self.pool.leases.release_runtime(runtime_id, session_id=session if reason != 'runtime_stop' else None,
                                                  reason=reason, observed_at=data.get('observedAt'))
        return self.respond({'released': result})

    def routes(self):
        return [('/api/environments', self.collection, ['GET', 'POST']),
                ('/api/environments/{environment_id}', self.resource, ['POST']),
                ('/api/environment', self.environment, ['GET', 'POST']),
                ('/api/environment/lease', self.lease, ['GET', 'POST']),
                ('/api/runtime/release', self.release_runtime, ['POST'])]
