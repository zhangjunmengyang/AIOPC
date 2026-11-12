"""Per-call MCP project routing. No process environment or shared cwd mutation."""

from __future__ import annotations

import inspect
import os
from collections.abc import Callable
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from pathlib import Path
from typing import Any, get_type_hints

from aiopc.authorized_workspaces import AuthorizedWorkspaces
from aiopc.company import Company


class WorkspaceScope:
    def __init__(self, home: Path, directory: Path, factory: Callable):
        self.home, self.default = Path(home).resolve(), Path(directory).resolve()
        self.company = (AuthorizedWorkspaces().resolve_context(str(self.default))[1]
                        if os.environ.get("AIOPC_AUTHORIZED_COMPANIES_FILE") else Company.from_directory(self.default))
        self.factory = factory
        self.workspaces: dict[Path, Any] = {}
        self.selection: ContextVar[Path] = ContextVar("aiopc_project", default=self.default)

    def current(self):
        path = self.selection.get()
        if path not in self.workspaces:
            self.workspaces[path] = self.factory(self.home, path)
            if hasattr(self.workspaces[path], "company"):
                self.workspaces[path].company = self.company
        return self.workspaces[path]

    @contextmanager
    def use(self, project: str = ""):
        path = self.company.resolve_project(project) if project else self.default
        token = self.selection.set(path)
        try:
            yield self.current()
        finally:
            self.selection.reset(token)

    def proxy(self):
        return _ScopedService(self)


class _ScopedService:
    def __init__(self, scope: WorkspaceScope, service: str = ""):
        self.scope, self.service = scope, service

    def _target(self):
        current = self.scope.current()
        return getattr(current, self.service) if self.service else current

    def __getattr__(self, name):
        value = getattr(self._target(), name)
        if not self.service and name in {"project", "social", "knowledge", "images", "xdata"}:
            return _ScopedService(self.scope, name)
        if not callable(value):
            return value

        @wraps(value)
        def call(*args, **kwargs):
            return getattr(self._target(), name)(*args, **kwargs)

        call.__signature__ = inspect.signature(value)
        call.__annotations__ = get_type_hints(value)
        return call
