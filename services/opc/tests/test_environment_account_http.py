import pytest
from starlette.testclient import TestClient

from aiopc.accounts import AccountStore
from aiopc.sandbox import registry
from aiopc.sandbox.environment import Environment, Provider, ProviderInfo
from aiopc.server import create_api
from aiopc.social import service
from aiopc.social.context import use_browser_context


@pytest.fixture
def browser_calls(monkeypatch):
    observed = []

    class LocalBrowserProvider(Provider):
        info = ProviderInfo(id="local", name="本地浏览器替身", kind="local", summary="测试")

        def __init__(self, _home):
            pass

        async def status(self, key, _state):
            return Environment(provider="local", status="running", id="provider-id", cdp_url=f"ws://fixture/{key.path}")

        async def ensure(self, key, state):
            return await self.status(key, state)

    class Browser:
        def __init__(self, endpoint):
            self.environment = endpoint.rsplit("/", 1)[-1]

        async def account(self, platform):
            observed.append((self.environment, platform))
            return {"id": self.environment, "name": f"账号 {self.environment}"}

    monkeypatch.setattr(registry, "LocalDockerProvider", LocalBrowserProvider)
    monkeypatch.setattr(service, "SandboxBrowser", Browser)
    return observed


def test_account_checks_use_each_selected_browser_and_release_finished_operations(tmp_path, browser_calls, memory_keyring):
    company = tmp_path / "company"
    project = company / "projects" / "alpha"
    project.mkdir(parents=True)
    app = create_api(tmp_path / "home", "local-test-token", authorized_roots=[company])
    with TestClient(app, headers={"Authorization": "Bearer local-test-token"}) as client:
        environments = []
        for name in ("主环境", "副环境"):
            created = client.post("/api/environments", params={"workspace": str(company)}, json={"name": name})
            assert created.status_code == 200, created.text
            environment = created.json()["id"]
            bound = client.post(f"/api/environments/{environment}", params={"workspace": str(company)},
                                json={"action": "bind", "project": str(project)})
            assert bound.status_code == 200, bound.text
            environments.append(environment)

        accounts = []
        for environment in environments:
            params = {"workspace": str(project), "environment": environment}
            checked = client.post("/api/accounts/connect", params=params, json={"platform": "x", "check": True})
            assert checked.status_code == 200, checked.text
            account = checked.json()["account"]
            assert account["environment"] == environment
            accounts.append(account)
        assert len({account["account_id"] for account in accounts}) == 2
        assert browser_calls == [(environment, "x") for environment in environments]

        for environment in environments:
            state = client.get("/api/environment/lease", params={"workspace": str(project), "environment": environment})
            assert state.status_code == 200, state.text
            assert state.json()["holder"] is None, state.text


@pytest.mark.parametrize("detached", [False, True])
async def test_login_refresh_only_checks_accounts_in_bound_environments(tmp_path, browser_calls, memory_keyring, detached):
    company = tmp_path / "company"
    project = company / "projects" / "alpha"
    project.mkdir(parents=True)
    home = tmp_path / "home"
    pool = registry.Sandboxes(home)
    old = pool.create_environment(str(company), "原环境")["id"]
    current = pool.create_environment(str(company), "当前环境")["id"]
    await pool.bind(old, str(project))
    await pool.bind(current, str(project))
    store = AccountStore(home)
    previous = store.upsert("x", {"id": current, "name": "原账号"}, project=str(project), environment=old)
    retained = store.upsert("x", {"id": current, "name": "当前账号"}, project=str(project), environment=current)
    await pool.unbind(old)
    if detached:
        store.detach_environment(old)

    social = service.SocialService(home, project, sandboxes=pool)
    owner = {"runtimeId": "desktop-ui", "sessionId": "account-refresh", "company": str(company),
             "projectDirectory": str(project), "kind": "human"}
    with use_browser_context(owner=owner):
        result = await social.check_logins(max_age=-1)

    assert result["checked"] == [{"platform": "x", "logged_in": True}]
    assert browser_calls == [(current, "x")]
    assert store.get(previous["id"])["logged_in"] is (not detached)
    assert store.get(retained["id"])["logged_in"] is True
