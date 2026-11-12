"""A custom CDP endpoint cannot become two independently leased resources."""
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError

import pytest

from aiopc import credentials
from aiopc.sandbox import Sandboxes
from aiopc.sandbox.environment import SandboxError


def test_parallel_aliases_share_one_atomic_manual_endpoint_reservation(tmp_path, monkeypatch):
    company = tmp_path / 'company'
    company.mkdir()
    home = tmp_path / 'home'
    saving, resume = threading.Event(), threading.Event()
    original = credentials.save

    def save(service, key, value):
        if service == 'environment' and threading.current_thread().name == 'manual-one':
            saving.set()
            assert resume.wait(10)
        original(service, key, value)

    monkeypatch.setattr(credentials, 'save', save)

    def create(name, url):
        threading.current_thread().name = name
        return Sandboxes(home).create_environment(str(company), name, 'manual', {'cdp_url': url})

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(create, 'manual-one', 'http://LOCALHOST:9222/')
        assert saving.wait(10)
        second = executor.submit(create, 'manual-two', 'http://localhost:9222')
        try:
            second.result(timeout=0.1)
        except TimeoutError:
            pass
        finally:
            resume.set()
        first.result()
        with pytest.raises(SandboxError, match='已被另一个环境使用'):
            second.result()
    assert len(Sandboxes(home).list_environments(str(company))) == 1


def test_credential_save_failure_leaves_no_half_registered_resource(tmp_path, monkeypatch):
    company = tmp_path / 'company'
    company.mkdir()
    pool = Sandboxes(tmp_path / 'home')

    def fail(*_args):
        raise credentials.CredentialError('keychain unavailable')

    monkeypatch.setattr(credentials, 'save', fail)
    with pytest.raises(credentials.CredentialError):
        pool.create_environment(str(company), 'manual', 'manual', {'cdp_url': 'http://localhost:9222'})
    assert pool.list_environments(str(company)) == []
