"""The local provider preserves profiles while installing Chromium's cookie policy."""

from __future__ import annotations

import json

import pytest

from aiopc.sandbox import ProjectKey, SandboxError, local


@pytest.fixture
def docker(monkeypatch, tmp_path):
    provider = local.LocalDockerProvider(tmp_path)
    key = ProjectKey(str(tmp_path / "project"))
    name = provider.container(key)
    commands = []
    container = {"exists": False, "running": False, "fail_copy": False}
    identifier = "sandbox-container-id"

    async def command(*args, **kwargs):
        commands.append(args)
        match args[0]:
            case "info" | "images":
                return "cached"
            case "inspect":
                if not container["exists"]:
                    return ""
                info = {
                    "Id": identifier,
                    "Config": {"Labels": {"aiopc.slug": key.slug}},
                    "State": {"Running": container["running"]},
                    "NetworkSettings": {"Ports": {"9223/tcp": [{"HostPort": "19000"}]}},
                }
                return json.dumps([info])
            case "create":
                container["exists"] = True
                return identifier
            case "cp":
                if container["fail_copy"]:
                    raise SandboxError("cannot copy policy")
                assert json.loads(local.COOKIE_POLICY_FILE.read_text()) == {"DefaultCookiesSetting": 1}
                assert args[2] == f"{identifier}:/etc/chromium/policies/managed/aiopc-cookie-persistence.json"
            case "start":
                container["running"] = True
            case "stop":
                container["running"] = False
            case "rm":
                container["exists"] = False
            case _:
                pytest.fail(f"unexpected Docker command: {args[0]}")
        return ""

    async def ready(*args):
        pass

    async def settle(seconds):
        commands.append(("settle", seconds))

    monkeypatch.setattr(local, "_docker", command)
    monkeypatch.setattr(local, "find_docker", lambda: "docker")
    monkeypatch.setattr(local.asyncio, "sleep", settle)
    monkeypatch.setattr(provider, "_wait_ready", ready)
    return provider, key, name, commands, container


async def test_cached_image_creates_and_copies_policy_before_start(docker):
    provider, key, name, commands, _ = docker
    state = {}

    await provider.ensure(key, state)

    assert [entry[0] for entry in commands] == ["info", "inspect", "images", "create", "cp", "start", "inspect"]
    assert commands[3][-1] == "aiopc/sandbox:1"
    assert f"{provider.volume(key)}:/home/neko/.config/chromium" in commands[3]
    assert state["container"] == name


async def test_existing_stopped_sandbox_gets_policy_before_resume(docker):
    provider, key, name, commands, container = docker
    container["exists"] = True
    state = {"container": name, "volume": "existing-profile"}

    await provider.ensure(key, state)
    await provider.ensure(key, state)

    assert [entry[0] for entry in commands] == ["info", "inspect", "cp", "start", "inspect", "info", "inspect"]
    assert state["volume"] == "existing-profile"


async def test_stopping_running_legacy_sandbox_waits_for_policy_refresh(docker):
    provider, key, name, commands, container = docker
    container.update(exists=True, running=True)
    state = {"container": name, "volume": "existing-profile"}

    await provider.stop(key, state)

    assert [entry[0] for entry in commands] == ["inspect", "cp", "settle", "stop"]
    assert commands[2][1] > 5
    assert state["volume"] == "existing-profile"


async def test_failed_policy_copy_does_not_stop_running_legacy_sandbox(docker):
    provider, key, name, commands, container = docker
    container.update(exists=True, running=True, fail_copy=True)

    with pytest.raises(SandboxError, match="cannot copy policy"):
        await provider.stop(key, {"container": name})

    assert [entry[0] for entry in commands] == ["inspect", "cp"]
    assert container["running"] is True


async def test_failed_policy_copy_removes_only_the_new_container(docker):
    provider, key, _, commands, container = docker
    container["fail_copy"] = True

    with pytest.raises(SandboxError, match="cannot copy policy"):
        await provider.ensure(key, {})

    assert [entry[0] for entry in commands] == ["info", "inspect", "images", "create", "cp", "rm"]
    assert commands[-1] == ("rm", "-f", "sandbox-container-id")
