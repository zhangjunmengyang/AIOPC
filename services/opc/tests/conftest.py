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
