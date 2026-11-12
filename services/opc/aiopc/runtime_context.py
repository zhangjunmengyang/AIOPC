"""Resolve native MCP metadata through the host's scoped session resolver."""
from __future__ import annotations

import json
import os
import stat
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import httpx


class RuntimeContextError(ValueError):
    code = 'runtime_context_required'


@dataclass(frozen=True)
class RuntimeIdentity:
    runtime_id: str
    session_id: str
    company: Path
    project_id: str | None
    project_directory: Path
    label: str
    ancestors: tuple[str, ...] = ()
    agent_name: str | None = None

    def owner(self):
        return {'runtimeId': self.runtime_id, 'sessionId': self.session_id, 'company': str(self.company),
                'projectDirectory': str(self.project_directory), 'kind': 'automation', 'label': self.label,
                'ancestors': list(self.ancestors)}


_current: ContextVar[RuntimeIdentity | None] = ContextVar('aiopc_runtime_context', default=None)


def current_runtime_context() -> RuntimeIdentity:
    value = _current.get()
    if value is None:
        raise RuntimeContextError('浏览器操作缺少可信会话上下文，请从 AIOPC 会话中调用')
    return value


@contextmanager
def use_runtime_context(identity: RuntimeIdentity):
    token = _current.set(identity)
    try:
        yield identity
    finally:
        _current.reset(token)


class RuntimeContextResolver:
    def __init__(self, home: Path, discovery_file: Path | None = None, *, transport=None):
        self.home = Path(home)
        configured = discovery_file or os.environ.get('AIOPC_RUNTIME_CONTEXT_FILE')
        self.discovery_file = Path(configured) if configured else None
        self.transport = transport

    @staticmethod
    def _discovery(path):
        try:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                raise ValueError('insecure discovery file')
            value = json.loads(path.read_text())
            url = urlparse(value['url'])
            if url.scheme != 'http' or url.hostname not in {'127.0.0.1', 'localhost', '::1'} or url.username or url.password:
                raise ValueError('resolver must be loopback')
            if url.path != '/runtime/session-context' or url.query or url.fragment:
                raise ValueError('invalid resolver path')
            if not isinstance(value['token'], str) or not value['token'] or not isinstance(value['runtimeId'], str):
                raise ValueError('invalid discovery')
            return value
        except (OSError, KeyError, TypeError, ValueError) as exc:
            raise RuntimeContextError('可信会话服务未就绪，请重新打开此会话') from exc

    async def resolve(self, meta, project: str = '') -> RuntimeIdentity:
        if hasattr(meta, 'model_dump'):
            meta = meta.model_dump()
        session_id = meta.get('ai.opencode/sessionID') if isinstance(meta, dict) else None
        if not isinstance(session_id, str) or not session_id.strip():
            raise RuntimeContextError('浏览器工具需要运行时提供可信 sessionID；不能由工具参数指定')
        identity = await self.resolve_session(session_id)
        if project and Path(project).expanduser().resolve() != identity.project_directory:
            raise RuntimeContextError('工具项目与会话所属项目不一致，请在目标项目新建会话')
        return identity

    async def resolve_session(self, session_id: str, *, runtime_id: str | None = None) -> RuntimeIdentity:
        if not isinstance(session_id, str) or not session_id or len(session_id) > 256:
            raise RuntimeContextError('会话标识无效')
        if runtime_id is not None:
            try:
                if str(uuid.UUID(runtime_id)) != runtime_id:
                    raise ValueError('invalid runtime')
            except (ValueError, TypeError, AttributeError) as exc:
                raise RuntimeContextError('运行时标识无效') from exc
            paths = [self.home / 'runtime-context' / f'{runtime_id}.json']
        elif self.discovery_file:
            paths = [self.discovery_file]
        else:
            paths = sorted((self.home / 'runtime-context').glob('*.json'))
        identities = []
        for path in paths:
            try:
                discovery = self._discovery(path)
                if runtime_id and discovery['runtimeId'] != runtime_id:
                    raise RuntimeContextError('运行时标识不一致')
                async with httpx.AsyncClient(transport=self.transport, timeout=10, follow_redirects=False, trust_env=False) as client:
                    response = await client.post(discovery['url'], headers={'x-aiopc-runtime-token': discovery['token']}, json={'sessionId': session_id})
                    response.raise_for_status()
                value = response.json()
                if value.get('sessionId') != session_id or value.get('runtimeId') != discovery['runtimeId']:
                    raise RuntimeContextError('会话服务返回了不同的会话归属')
                company = Path(value['company']).resolve(strict=True)
                project = Path(value['projectDirectory'] or value['company']).resolve(strict=True)
                project_id = value.get('projectId')
                if project_id is None:
                    if project != company:
                        raise RuntimeContextError('公司会话目录不一致')
                elif not isinstance(project_id, str) or not project_id.startswith('proj:') or project.name != project_id[5:] or project.parent != company / 'projects':
                    raise RuntimeContextError('项目会话目录不在公司项目边界内')
                if not company.is_dir() or not project.is_dir():
                    raise RuntimeContextError('会话目录不存在')
                ancestors = value.get('ancestors', [])
                if not isinstance(ancestors, list) or not all(isinstance(item, str) and item for item in ancestors):
                    raise RuntimeContextError('会话父链无效')
                identities.append(RuntimeIdentity(discovery['runtimeId'], session_id, company, project_id, project,
                                                  str(value.get('label') or session_id)[:256], tuple(ancestors), value.get('agentName')))
            except (httpx.HTTPError, OSError, KeyError, TypeError, ValueError) as exc:
                if len(paths) == 1:
                    if isinstance(exc, RuntimeContextError):
                        raise
                    raise RuntimeContextError('无法核实此会话的项目归属') from exc
        if len(identities) != 1:
            raise RuntimeContextError('无法唯一确认会话运行时，请重新打开此会话')
        return identities[0]
