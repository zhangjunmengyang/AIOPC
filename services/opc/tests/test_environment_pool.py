import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from aiopc.accounts import AccountStore
from aiopc.company import Company
from aiopc.sandbox import Sandboxes
from aiopc.sandbox.environment import Environment, Provider, ProviderInfo, SandboxError


class FakeProvider(Provider):
    info = ProviderInfo(id="fake", name="测试环境", kind="local", summary="只在测试中运行")

    def __init__(self):
        self.reset_calls = []

    async def status(self, key, state):
        return Environment(provider="fake", status="running", id="remote-session", cdp_url="ws://test")

    async def ensure(self, key, state):
        state.setdefault("profile", "profile-" + key.slug)
        return await self.status(key, state)

    async def reset(self, key, state):
        self.reset_calls.append(dict(state))
        state.clear()


def setup_pool(tmp_path):
    company = Company(tmp_path / "company")
    company.root.mkdir()
    alpha = company.create("alpha")["path"]
    beta = company.create("beta")["path"]
    pool = Sandboxes(tmp_path / "home")
    provider = FakeProvider()
    pool._providers["fake"] = provider
    return company, alpha, beta, pool, provider


async def test_project_can_bind_two_environments_with_explicit_selection(tmp_path):
    company, alpha, beta, pool, _ = setup_pool(tmp_path)
    one = pool.create_environment(str(company.root), "主账号", "fake")
    two = pool.create_environment(str(company.root), "副账号", "fake")
    assert one["id"] != two["id"]
    await pool.bind(one["id"], alpha)
    assert pool.resolve(alpha)["id"] == one["id"]
    await pool.bind(two["id"], alpha)
    with pytest.raises(SandboxError, match="多个"):
        pool.resolve(alpha)
    assert pool.resolve(alpha, two["id"])["id"] == two["id"]
    with pytest.raises(SandboxError, match="绑定"):
        pool.resolve(beta, one["id"])
    bindings = json.loads((company.resolve_project("alpha") / "environments.json").read_text())
    assert set(bindings["environments"]) == {one["id"], two["id"]}
    running = await pool.ensure(alpha, one["id"])
    assert running.id == one["id"]  # Provider session IDs cannot replace local resource identity.


async def test_unbind_and_same_project_rebind_preserves_profile(tmp_path):
    company, alpha, _, pool, provider = setup_pool(tmp_path)
    env = pool.create_environment(str(company.root), "主账号", "fake")
    await pool.bind(env["id"], alpha)
    await pool.ensure(alpha, env["id"])
    profile = pool.get(env["id"])["state"]["profile"]
    await pool.unbind(env["id"])
    assert pool.get(env["id"])["boundProject"] is None
    assert pool.get(env["id"])["lastProject"] == alpha
    await pool.bind(env["id"], alpha)
    assert pool.get(env["id"])["state"]["profile"] == profile
    assert provider.reset_calls == []


async def test_cross_project_bind_requires_review_then_clears_only_affected_accounts(tmp_path):
    company, alpha, beta, pool, provider = setup_pool(tmp_path)
    env = pool.create_environment(str(company.root), "主账号", "fake")
    other = pool.create_environment(str(company.root), "副账号", "fake")
    await pool.bind(env["id"], alpha)
    await pool.bind(other["id"], alpha)
    await pool.ensure(alpha, env["id"])
    accounts = AccountStore(pool.home)
    old = accounts.upsert("xhs", {"id": "same-user", "name": "主账号"}, project=alpha, environment=env["id"])
    untouched = accounts.upsert("xhs", {"id": "same-user", "name": "副账号"}, project=alpha, environment=other["id"])
    assert old["id"] != untouched["id"]
    await pool.unbind(env["id"])
    review = await pool.bind(env["id"], beta)
    assert review["requires_confirmation"] is True
    assert [item["account_id"] for item in review["affectedAccounts"]] == [old["id"]]
    assert provider.reset_calls == [] and pool.get(env["id"])["boundProject"] is None
    await pool.bind(env["id"], beta, confirmation=review["confirmation"])
    assert len(provider.reset_calls) == 1
    assert pool.get(env["id"])["boundProject"] == beta
    saved = accounts.get(old["id"])
    assert saved["project"] == alpha and saved["logged_in"] is False and not saved.get("environment")
    assert accounts.get(untouched["id"])["logged_in"] is True
    assert accounts.get(untouched["id"])["environment"] == other["id"]


async def test_stale_bind_confirmation_does_not_clear_changed_accounts(tmp_path):
    company, alpha, beta, pool, provider = setup_pool(tmp_path)
    env = pool.create_environment(str(company.root), "主账号", "fake")
    await pool.bind(env["id"], alpha)
    await pool.unbind(env["id"])
    review = await pool.bind(env["id"], beta)
    AccountStore(pool.home).upsert("xhs", {"id": "new", "name": "后来登录"}, project=alpha, environment=env["id"])
    renewed = await pool.bind(env["id"], beta, confirmation=review["confirmation"])
    assert renewed["requires_confirmation"] is True
    assert provider.reset_calls == []


def test_legacy_migration_preserves_container_and_profile_without_provider_calls(tmp_path):
    company = tmp_path / "old-workspace"
    company.mkdir()
    home = tmp_path / "home"
    home.mkdir()
    legacy = {"provider": "local", "projects": {str(company): {
        "provider": "local", "state": {"container": "original-container", "password": "test-only"}}}}
    (home / "sandbox.json").write_text(json.dumps(legacy))
    accounts = AccountStore(home)
    account = accounts.upsert("xhs", {"id": "old", "name": "旧账号"}, project=str(company))
    pool = Sandboxes(home)
    first = pool.list_environments(str(company))
    assert len(first) == 1 and first[0]["boundProject"] == str(company)
    assert first[0]["state"]["container"] == "original-container"
    assert first[0]["state"]["password"] == "test-only"
    assert first[0]["resourceKey"] == str(company)
    assert accounts.get(account["id"])["environment"] == first[0]["id"]
    assert Sandboxes(home).list_environments(str(company))[0]["id"] == first[0]["id"]
    assert json.loads((home / "sandbox.v1.backup.json").read_text()) == legacy


def test_parallel_registry_instances_do_not_lose_created_environments(tmp_path):
    company = tmp_path / "company"
    company.mkdir()
    def create(index):
        return Sandboxes(tmp_path / "home").create_environment(str(company), f"环境{index}", "local")["id"]
    with ThreadPoolExecutor(max_workers=4) as executor:
        ids = list(executor.map(create, range(12)))
    assert {item["id"] for item in Sandboxes(tmp_path / "home").list_environments(str(company))} == set(ids)


def test_account_identity_is_scoped_by_project_and_environment(tmp_path):
    accounts = AccountStore(tmp_path)
    first = accounts.upsert("github", {"id": "same"}, project="/A")
    second = accounts.upsert("github", {"id": "same"}, project="/B")
    assert first["id"] != second["id"]
    assert accounts.upsert("github", {"id": "same"}, project="/A")["id"] == first["id"]


async def test_local_provider_lifecycle_uses_migrated_resource_names(monkeypatch, tmp_path):
    from aiopc.sandbox import local
    from aiopc.sandbox.environment import ProjectKey
    calls = []
    async def docker(*args, **kwargs):
        calls.append(args)
        return ""
    monkeypatch.setattr(local, "_docker", docker)
    monkeypatch.setattr(local, "find_docker", lambda: "docker")
    provider = local.LocalDockerProvider(tmp_path)
    async def inspect(name):
        calls.append(("inspect-name", name))
        return {"State": {"Running": False}}
    monkeypatch.setattr(provider, "_inspect", inspect)
    state = {"container": "old-container", "volume": "old-profile"}
    key = ProjectKey("env_new_identity")
    await provider.status(key, state)
    await provider.stop(key, state)
    await provider.destroy(key, state)
    assert ("inspect-name", "old-container") in calls
    assert ("stop", "old-container") in calls
    assert ("rm", "-f", "old-container") in calls
    assert ("volume", "rm", "old-profile") in calls


def test_relogin_recovers_detached_account_identity_and_history(tmp_path):
    accounts = AccountStore(tmp_path)
    before = accounts.upsert("xhs", {"id": "same"}, project="/A", environment="env_old")
    accounts.detach_environment("env_old")
    after = accounts.upsert("xhs", {"id": "same"}, project="/A", environment="env_new")
    assert after["id"] == before["id"] and after["created_at"] == before["created_at"]
    assert after["environment"] == "env_new" and after["logged_in"] is True


async def test_direct_reassignment_keeps_old_binding_until_confirmation(tmp_path):
    company, alpha, beta, pool, provider = setup_pool(tmp_path)
    env = pool.create_environment(str(company.root), '主账号', 'fake')
    await pool.bind(env['id'], alpha)
    review = await pool.bind(env['id'], beta)
    assert review['requires_confirmation']
    assert pool.get(env['id'])['boundProject'] == alpha
    assert not provider.reset_calls
    await pool.bind(env['id'], beta, confirmation=review['confirmation'])
    assert pool.get(env['id'])['boundProject'] == beta
    assert json.loads((company.resolve_project('alpha') / 'environments.json').read_text())['environments'] == []
    assert json.loads((company.resolve_project('beta') / 'environments.json').read_text())['environments'] == [env['id']]


def test_legacy_browseruse_profile_becomes_per_environment_state(tmp_path):
    from aiopc import credentials
    company = tmp_path / 'company'
    company.mkdir()
    home = tmp_path / 'home'
    home.mkdir()
    credentials.save('sandbox','browseruse',{'api_key':'test','profile_id':'original-profile'})
    (home/'sandbox.json').write_text(json.dumps({'projects':{str(company):{'provider':'browseruse','state':{'session':'original-session'}}}}))
    env = Sandboxes(home).list_environments(str(company))[0]
    assert env['state']['profile'] == 'original-profile'
    assert json.loads((company/'environments.json').read_text())['environments'] == [env['id']]
