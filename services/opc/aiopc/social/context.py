"""Per-call browser selection and trusted owner, shared by MCP and authenticated UI."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar

from aiopc.runtime_context import current_runtime_context

_context: ContextVar[tuple[str, dict | None]] = ContextVar('aiopc_browser_context', default=('', None))
_managers: ContextVar[list | None] = ContextVar('aiopc_browser_managers', default=None)


@contextmanager
def use_browser_context(environment: str = '', owner: dict | None = None):
    previous = _context.get()
    manages_scope = owner is not None or _managers.get() is None
    managers_token = _managers.set([]) if manages_scope else None
    token = _context.set((environment or previous[0], owner if owner is not None else previous[1]))
    try:
        yield
    finally:
        try:
            if manages_scope and owner and owner.get('kind') == 'human':
                for manager in _managers.get() or []:
                    manager.release_owner(owner, reason='turn_end')
        finally:
            if managers_token is not None:
                _managers.reset(managers_token)
            _context.reset(token)


def selected_environment() -> str:
    return _context.get()[0]


def browser_owner() -> dict:
    return _context.get()[1] or current_runtime_context().owner()


def register_browser_manager(manager):
    managers = _managers.get()
    if managers is not None and manager not in managers:
        managers.append(manager)


class LeasedBrowser:
    """Wrap each complete browser method, retaining the shared per-session lease."""
    def __init__(self, browser, manager, record, owner):
        self._browser, self.manager, self.record, self.owner = browser, manager, record, owner
        self.environment_id = record['id']

    def operation(self):
        return self.manager.operation(self.environment_id, self.owner, self.record['bindingRevision'])

    def wait(self, lease_id):
        return self.manager.wait_for_user(self.environment_id, self.owner, lease_id)

    def __getattr__(self, name):
        value = getattr(self._browser, name)
        if not callable(value):
            return value

        async def invoke(*args, **kwargs):
            async with self.operation():
                return await value(*args, **kwargs)
        return invoke
