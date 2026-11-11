"""Environments: the computer a project's browser runs on."""

from .environment import Environment, ProjectKey, SandboxError
from .local import install_engine
from .registry import Sandboxes

__all__ = ["Environment", "ProjectKey", "SandboxError", "Sandboxes", "install_engine"]
