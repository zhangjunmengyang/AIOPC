"""The runner executes only staged skill files in disposable local containers."""

from __future__ import annotations

import asyncio
import csv
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

from aiopc.sandbox import local, skill_runner
from aiopc.sandbox.environment import SandboxError

IMAGE_ID = "sha256:" + "a" * 64
CONTAINER_ID = "b" * 64


@pytest.fixture
def setup(tmp_path):
    bundle = tmp_path / "bundle"
    (bundle / "scripts").mkdir(parents=True)
    (bundle / "scripts" / "example.py").write_text("print('example')\n")
    provider = local.LocalDockerProvider(tmp_path / "home")
    return provider, bundle


def fake_docker(monkeypatch, provider, *, start=None, volumes="null", exit_code=7):
    commands = []
    image_ready = []

    async def ready():
        image_ready.append(True)

    async def local_command():
        return ("docker", "--host", "unix:///local.sock")

    async def call(command, *, timeout_s):
        assert command[:3] == ("docker", "--host", "unix:///local.sock")
        args = command[3:]
        commands.append(args)
        if args[:2] == ("image", "inspect"):
            return skill_runner._CommandResult(0, f"{IMAGE_ID} {volumes}")
        if args[0] == "create":
            mount = next(csv.reader([args[args.index("--mount") + 1]]))
            assert mount[0] == "type=bind" and mount[2:] == ["target=/skill", "readonly"]
            staged = Path(mount[1].removeprefix("source="))
            assert (staged / "scripts/example.py").read_text() == "print('example')\n"
            return skill_runner._CommandResult(0, CONTAINER_ID)
        if args[0] == "start":
            if start:
                return await start()
            return skill_runner._CommandResult(1, "output\n", "failure\n", True)
        if args[:2] == ("container", "inspect"):
            return skill_runner._CommandResult(0, json.dumps({"Status": "exited", "ExitCode": exit_code, "Error": ""}))
        if args[0] == "rm":
            return skill_runner._CommandResult(0, CONTAINER_ID)
        raise AssertionError(args)

    monkeypatch.setattr(provider, "_image_ready", ready)
    monkeypatch.setattr(skill_runner, "_local_command", local_command)
    monkeypatch.setattr(skill_runner, "_call", call)
    return commands, image_ready


async def test_run_pins_image_and_only_mounts_a_read_only_copy(setup, monkeypatch):
    provider, bundle = setup
    commands, image_ready = fake_docker(monkeypatch, provider)
    result = await skill_runner.run_skill_script(provider, bundle, "scripts/example.py", ("a; b", "--arg"))

    assert result == {"exit_code": 7, "stdout": "output\n", "stderr": "failure\n", "truncated": True}
    assert image_ready == [True]
    create = commands[1]
    assert create.count("--mount") == 1
    mount = next(csv.reader([create[create.index("--mount") + 1]]))
    assert Path(mount[1].removeprefix("source=")) != bundle
    assert not Path(mount[1].removeprefix("source=")).exists()
    assert str(bundle) not in " ".join(create)
    assert {"--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges=true",
            "--user=65534:65534", "--log-driver=none", "--pids-limit=64", "--memory=256m"} <= set(create)
    assert create[create.index("--entrypoint"):] == (
        "--entrypoint", "/usr/bin/python3", IMAGE_ID, "-I", "-B", "/skill/scripts/example.py", "a; b", "--arg",
    )
    assert commands[-1] == ("rm", "--force", "--volumes", CONTAINER_ID)


@pytest.mark.parametrize("entry", ["/scripts/example.py", "scripts/../example.py", "scripts//example.py", "other.py", "scripts/example.js"])
async def test_invalid_entry_never_reaches_docker(setup, monkeypatch, entry):
    provider, bundle = setup
    commands, image_ready = fake_docker(monkeypatch, provider)
    with pytest.raises(SandboxError):
        await skill_runner.run_skill_script(provider, bundle, entry)
    assert commands == image_ready == []


async def test_symlink_and_hardlink_are_rejected_before_docker(setup, monkeypatch, tmp_path):
    provider, bundle = setup
    commands, image_ready = fake_docker(monkeypatch, provider)
    private = tmp_path / "private.txt"
    private.write_text("kept on the host")
    extra = bundle / "extra.txt"
    extra.symlink_to(private)
    with pytest.raises(SandboxError):
        await skill_runner.run_skill_script(provider, bundle, "scripts/example.py")
    extra.unlink()
    extra.hardlink_to(private)
    with pytest.raises(SandboxError):
        await skill_runner.run_skill_script(provider, bundle, "scripts/example.py")
    assert commands == image_ready == []


async def test_images_declaring_implicit_volumes_are_refused(setup, monkeypatch):
    provider, bundle = setup
    commands, _ = fake_docker(monkeypatch, provider, volumes='{"/profile":{}}')
    with pytest.raises(SandboxError):
        await skill_runner.run_skill_script(provider, bundle, "scripts/example.py")
    assert [command[0] for command in commands] == ["image"]


async def test_timeout_removes_exact_container(setup, monkeypatch):
    provider, bundle = setup

    async def start():
        raise TimeoutError

    commands, _ = fake_docker(monkeypatch, provider, start=start)
    with pytest.raises(SandboxError, match="超时"):
        await skill_runner.run_skill_script(provider, bundle, "scripts/example.py", timeout_s=0.1)
    assert commands[-1] == ("rm", "--force", "--volumes", CONTAINER_ID)


async def test_cancellation_removes_exact_container(setup, monkeypatch):
    provider, bundle = setup
    running = asyncio.Event()

    async def start():
        running.set()
        await asyncio.Event().wait()

    commands, _ = fake_docker(monkeypatch, provider, start=start)
    task = asyncio.create_task(skill_runner.run_skill_script(provider, bundle, "scripts/example.py"))
    await running.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert commands[-1] == ("rm", "--force", "--volumes", CONTAINER_ID)


async def test_subprocess_capture_bounds_both_streams():
    program = "import sys; sys.stdout.write('a' * 100000); sys.stderr.write('b' * 100000); sys.exit(3)"
    output = await skill_runner._call((sys.executable, "-I", "-c", program), timeout_s=5)
    assert output.returncode == 3 and output.truncated
    assert 0 < len(output.stdout) < 100000 and 0 < len(output.stderr) < 100000
    assert set(output.stdout) == {"a"} and set(output.stderr) == {"b"}


async def test_remote_docker_endpoint_is_refused(monkeypatch):
    monkeypatch.setattr(local, "find_docker", lambda: "docker")
    monkeypatch.delenv("DOCKER_CONTEXT", raising=False)
    monkeypatch.setenv("DOCKER_HOST", "tcp://127.0.0.1:2375")
    with pytest.raises(SandboxError, match="本机"):
        await skill_runner._local_command()


@pytest.mark.skipif(os.environ.get("AIOPC_TEST_SKILL_SANDBOX_DOCKER") != "1", reason="requires a preloaded local AIOPC Docker image")
async def test_real_docker_runs_only_self_written_fixtures(setup, monkeypatch, tmp_path):
    provider, bundle = setup
    docker = shutil.which("docker")
    assert docker is not None
    monkeypatch.setattr(local, "find_docker", lambda: docker)
    docker_command = await skill_runner._local_command()
    image = await skill_runner._call((*docker_command, "image", "inspect", local.IMAGE), timeout_s=10)
    assert image.returncode == 0
    host_file = tmp_path / "host-only.txt"
    host_file.write_text("not mounted")
    probe = """\
import os
from pathlib import Path
import sys

assert os.getuid() == 65534
assert not Path(sys.argv[1]).exists()
assert not Path('/var/run/docker.sock').exists()
assert not os.getenv('AIOPC_SKILL_SANDBOX_TEST_SECRET')
interfaces = Path('/proc/net/dev').read_text().splitlines()[2:]
assert {line.split(':')[0].strip() for line in interfaces} == {'lo'}
try:
    Path('/skill/test-write').write_text('blocked')
except PermissionError:
    pass
except OSError as exc:
    assert exc.errno == 30
else:
    raise AssertionError('skill mount is writable')
print('isolated fixture')
"""
    monkeypatch.setenv("AIOPC_SKILL_SANDBOX_TEST_SECRET", "not forwarded")
    (bundle / "scripts/example.py").write_text(probe)
    (bundle / "scripts/fail.sh").write_text("printf 'expected error\\n' >&2\nexit 7\n")
    (bundle / "scripts/wait.sh").write_text("sleep 15\n")
    called = []
    real_call = skill_runner._call

    async def collect(command, *, timeout_s):
        if "create" in command and "--name" in command:
            called.append(command[command.index("--name") + 1])
        return await real_call(command, timeout_s=timeout_s)

    monkeypatch.setattr(skill_runner, "_call", collect)
    result = await skill_runner.run_skill_script(provider, bundle, "scripts/example.py", [str(host_file)])
    assert result == {"exit_code": 0, "stdout": "isolated fixture\n", "stderr": "", "truncated": False}
    result = await skill_runner.run_skill_script(provider, bundle, "scripts/fail.sh")
    assert result["exit_code"] == 7 and result["stderr"] == "expected error\n"
    with pytest.raises(SandboxError, match="超时"):
        await skill_runner.run_skill_script(provider, bundle, "scripts/wait.sh", timeout_s=0.5)
    assert len(called) == 3
    for name in called:
        result = await skill_runner._call((*docker_command, "container", "inspect", name), timeout_s=10)
        assert result.returncode != 0 and "No such container" in result.stderr
