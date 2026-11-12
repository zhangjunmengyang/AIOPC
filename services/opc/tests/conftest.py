import keyring
import pytest
from keyring.backend import KeyringBackend


class MemoryKeyring(KeyringBackend):
    priority = 1

    def __init__(self):
        super().__init__()
        self.store = {}

    def set_password(self, service, username, password):
        self.store[(service, username)] = password

    def get_password(self, service, username):
        return self.store.get((service, username))

    def delete_password(self, service, username):
        self.store.pop((service, username), None)


@pytest.fixture(autouse=True)
def no_container_engine(monkeypatch):
    """Tests run as if this machine had no container engine, so the built-in browser is the default."""
    from aiopc.sandbox import local

    monkeypatch.setattr(local, "find_docker", lambda: None)


@pytest.fixture(autouse=True)
def memory_keyring(monkeypatch):
    """Tests never touch the real macOS Keychain."""
    backend = MemoryKeyring()
    previous = keyring.get_keyring()
    keyring.set_keyring(backend)
    monkeypatch.delenv("TWITTERAPI_IO_KEY", raising=False)
    yield backend
    keyring.set_keyring(previous)


@pytest.fixture
def project_mcp_metadata(monkeypatch):
    """Send real MCP metadata while keeping the host identity lookup in the test."""
    from aiopc.runtime_context import RuntimeContextError, RuntimeContextResolver, RuntimeIdentity

    def configure(company, project_name):
        session_id = "ses_" + project_name
        project = company.resolve_project(project_name)

        async def resolve_session(_resolver, requested, *, runtime_id=None):
            if requested != session_id:
                raise RuntimeContextError("会话不属于当前项目")
            return RuntimeIdentity("test-runtime", session_id, company.root, f"proj:{project_name}", project, "Fixture")

        monkeypatch.setattr(RuntimeContextResolver, "resolve_session", resolve_session)
        return {"ai.opencode/sessionID": session_id}

    return configure
