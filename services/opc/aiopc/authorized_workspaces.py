"""HTTP workspaces must be opened by the local desktop host, never arbitrary paths."""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

from aiopc.company import Company


class WorkspaceForbidden(ValueError):
    status = 403
    code = 'workspace_forbidden'


class AuthorizedWorkspaces:
    def __init__(self, roots=None):
        self.explicit = tuple(Path(item).resolve() for item in roots) if roots is not None else None

    def roots(self):
        if self.explicit is not None:
            return tuple(root for root in self.explicit if self._unchanged_root(root))
        configured = os.environ.get('AIOPC_AUTHORIZED_COMPANIES_FILE')
        if not configured:
            return ()
        path = Path(configured)
        try:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                return ()
            data = json.loads(path.read_text())
            if data.get('version') != 1 or not isinstance(data.get('roots'), list):
                return ()
            return tuple(Path(item) for item in data['roots'] if isinstance(item, str)
                         and self._unchanged_root(Path(item)))
        except (OSError, ValueError, TypeError):
            return ()

    @staticmethod
    def _unchanged_root(path):
        # The host writes canonical roots. A later symlink replacement must not
        # silently transfer that authorization to another physical directory.
        return path.is_absolute() and path.is_dir() and not path.is_symlink() and path.resolve() == path

    def resolve(self, value):
        return self.resolve_context(value)[0]

    def resolve_context(self, value):
        if not isinstance(value, str) or not value:
            raise WorkspaceForbidden('缺少已打开的公司路径')
        raw = Path(value).expanduser()
        if not raw.is_absolute() or not raw.is_dir() or raw.is_symlink():
            raise WorkspaceForbidden('此目录未在 AIOPC 中打开')
        path = raw.resolve()
        roots = self.roots()
        # A registered company wins even when it is itself below another root's
        # projects directory. Directory names alone are not company authority.
        for root in roots:
            if path == root:
                return path, Company(root)
        for root in roots:
            if path.parent == root / 'projects':
                try:
                    return Company(root).resolve_project(str(raw)), Company(root)
                except ValueError:
                    pass
        raise WorkspaceForbidden('此目录不属于已打开的公司或其项目')
