import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

from aiopc.sandbox.leases import LeaseError, LeaseManager


def owner(session="one", kind="automation"):
    return {"runtimeId": "runtime", "sessionId": session, "company": "/company", "projectDirectory": "/company/projects/A",
            "kind": kind, "label": session}


def manager(tmp_path, clock=None, binding=None):
    return LeaseManager(tmp_path, clock=clock or __import__("time").time,
                        binding_resolver=lambda _: binding or {"company": "/company", "boundProject": "/company/projects/A", "bindingRevision": 1})


def test_fifo_human_priority_and_active_operation_are_shared_across_managers(tmp_path):
    a, b = manager(tmp_path), manager(tmp_path)
    first = a.acquire("env", owner(), 1)
    assert first["state"] == "granted"
    assert a.begin_operation("env", owner(), first["leaseId"], 1, "operation")["state"] == "granted"
    second = b.acquire("env", owner("two"), 1, request_id="two")
    third = b.acquire("env", owner("three"), 1, request_id="three")
    human = b.acquire("env", owner("person", "human"), 1, request_id="human")
    assert [second["state"], third["state"], human["state"]] == ["queued"] * 3
    assert a.status("env")["queue"][0]["requestId"] == "human"
    a.end_operation("env", owner(), first["leaseId"], "operation")
    human = b.acquire("env", owner("person", "human"), 1, request_id="human")
    assert human["state"] == "granted"
    assert b.release("env", owner("person", "human"), human["leaseId"])
    assert b.acquire("env", owner("three"), 1, request_id="three")["state"] == "queued"
    second = b.acquire("env", owner("two"), 1, request_id="two")
    assert second["state"] == "granted"
    assert "leaseId" not in b.status("env")["holder"]


def test_expiry_is_activity_based_and_login_hold_has_a_fixed_upper_bound(tmp_path):
    now = [1000.0]
    leases = manager(tmp_path, lambda: now[0])
    first = leases.acquire("env", owner(), 1)
    now[0] += 59
    leases.heartbeat("env", owner(), first["leaseId"])
    now[0] += 2
    assert leases.status("env")["holder"] is None, "idle polling must not renew the browser lease"
    first = leases.acquire("env", owner(), 1)
    leases.wait_for_user("env", owner(), first["leaseId"])
    assert leases.release_owner(owner(), reason="turn_end") == 0
    now[0] += 599
    leases.wait_for_user("env", owner(), first["leaseId"])
    assert leases.status("env")["holder"] is not None
    now[0] += 2
    assert leases.status("env")["holder"] is None
    first = leases.acquire("env", owner(), 1)
    leases.wait_for_user("env", owner(), first["leaseId"])
    assert leases.release_owner(owner(), reason="closed") == 1


def test_binding_revision_and_identity_are_checked_again_before_operations(tmp_path):
    binding = {"company": "/company", "boundProject": "/company/projects/A", "bindingRevision": 1}
    leases = manager(tmp_path, binding=binding)
    first = leases.acquire("env", owner(), 1)
    with pytest.raises(LeaseError, match="归属"):
        leases.acquire("env", {**owner("foreign"), "company": "/foreign"}, 1)
    binding["bindingRevision"] = 2
    with pytest.raises(LeaseError, match="绑定"):
        leases.begin_operation("env", owner(), first["leaseId"], 1, "old")
    with pytest.raises(LeaseError):
        leases.begin_operation("env", owner("other"), first["leaseId"], 2, "forged")


def test_same_owner_cannot_overlap_operations_and_different_environments_continue(tmp_path):
    leases = manager(tmp_path)
    first = leases.acquire("env", owner(), 1)
    assert leases.begin_operation("env", owner(), first["leaseId"], 1, "first")["state"] == "granted"
    assert leases.begin_operation("env", owner(), first["leaseId"], 1, "parallel")["state"] == "busy"
    other = leases.acquire("other", owner("two"), 1)
    assert leases.begin_operation("other", owner("two"), other["leaseId"], 1, "parallel")["state"] == "granted"
    assert not leases.end_operation("env", owner(), first["leaseId"], "wrong")
    assert not leases.end_operation("env", owner("forged"), first["leaseId"], "first")
    assert leases.end_operation("env", owner(), first["leaseId"], "first")


def test_lease_ownership_survives_process_exit(tmp_path):
    script = "import json,sys;sys.path.insert(0,sys.argv[1]);from aiopc.sandbox.leases import LeaseManager;print(json.dumps(LeaseManager(sys.argv[2]).acquire('env',json.loads(sys.argv[3]),1)))"
    args = [sys.executable, "-I", "-c", script, str(Path(__file__).resolve().parents[1]), str(tmp_path)]
    first = json.loads(subprocess.check_output([*args, json.dumps(owner())], text=True))
    second = json.loads(subprocess.check_output([*args, json.dumps(owner("two"))], text=True))
    assert first["state"] == "granted"
    assert second["state"] == "queued"


@pytest.mark.asyncio
async def test_async_operation_context_serializes_and_cancellation_removes_waiter(tmp_path):
    leases = manager(tmp_path)
    events = []
    entered = asyncio.Event()
    release = asyncio.Event()

    async def first():
        async with leases.operation("env", owner(), 1):
            events.append("first")
            entered.set()
            await release.wait()

    async def second():
        async with leases.operation("env", owner("two"), 1):
            events.append("second")

    task = asyncio.create_task(first())
    await entered.wait()
    waiting = asyncio.create_task(second())
    await asyncio.sleep(0.1)
    assert events == ["first"]
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    assert leases.status("env")["queue"] == []
    release.set()
    await task


def test_child_cannot_deadlock_waiting_for_the_parent_lease(tmp_path):
    leases = manager(tmp_path)
    leases.acquire("env", owner("parent"), 1)
    with pytest.raises(LeaseError, match="父子"):
        leases.acquire("env", {**owner("child"), "ancestors": ["parent"]}, 1)


@pytest.mark.asyncio
async def test_nested_business_calls_reuse_only_the_same_task_operation(tmp_path):
    leases = manager(tmp_path)

    async def nested():
        async with leases.operation("env", owner(), 1) as outer, leases.operation("env", owner(), 1) as inner:
            assert inner == outer

    await asyncio.wait_for(nested(), 0.3)


@pytest.mark.asyncio
async def test_maintenance_shares_operation_mutex_and_releases_after_binding_changes(tmp_path):
    binding = {"company": "/company", "boundProject": None, "bindingRevision": 1}
    leases = manager(tmp_path, binding=binding)
    async with leases.maintenance("env", 1):
        queued = leases.acquire("env", owner("person", "human"), 1)
        assert queued["state"] == "queued"
        with pytest.raises(LeaseError, match="使用"):
            async with leases.maintenance("env", 1):
                pytest.fail("overlapping maintenance")
        binding["bindingRevision"] = 2
        binding["boundProject"] = "/company/projects/A"
    assert leases.acquire("env", owner(), 2)["state"] == "granted"
    with pytest.raises(LeaseError, match="使用"):
        async with leases.maintenance("env", 2):
            pytest.fail("maintenance while leased")


def test_delayed_turn_end_does_not_release_a_new_browser_operation(tmp_path):
    now = [1000.0]
    leases = manager(tmp_path, lambda: now[0])
    first = leases.acquire('env', owner(), 1)
    observed_at = now[0] * 1000
    now[0] += 1
    leases.begin_operation('env', owner(), first['leaseId'], 1, 'next-turn')
    assert leases.release_owner(owner(), observed_at=observed_at) == 0
    assert leases.status('env')['holder'] is not None
    leases.end_operation('env', owner(), first['leaseId'], 'next-turn')
    assert leases.release_owner(owner(), observed_at=now[0] * 1000) == 1


def test_runtime_release_is_scoped_to_automation_and_observation_time(tmp_path):
    now = [1000.0]
    leases = manager(tmp_path, lambda: now[0])
    leases.acquire('env', owner(), 1)
    leases.acquire('human', owner('ui', 'human'), 1)
    leases.acquire('other', {**owner(), 'runtimeId': 'other'}, 1)
    assert leases.release_runtime('runtime', session_id='one', reason='turn_end', observed_at=1000000) == 1
    assert leases.status('human')['holder'] is not None
    assert leases.status('other')['holder'] is not None
    leases.acquire('env', owner('two'), 1)
    assert leases.release_runtime('runtime', reason='runtime_stop') == 1


def test_runtime_stop_prevents_inflight_owner_reacquiring(tmp_path):
    leases = manager(tmp_path)
    leases.acquire('env', owner(), 1)
    leases.release_runtime('runtime', reason='runtime_stop')
    with pytest.raises(LeaseError, match='结束'):
        leases.acquire('env', owner(), 1)


def test_parallel_broker_initialization_migrates_schema_once(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    barrier = Barrier(12)

    def initialize(_):
        barrier.wait()
        return LeaseManager(tmp_path).status('env')
    with ThreadPoolExecutor(max_workers=12) as pool:
        assert len(list(pool.map(initialize, range(12)))) == 12


def test_policy_file_configures_shared_durations_and_explicit_values_win(tmp_path):
    policy = tmp_path / 'sandbox-policy.json'
    policy.write_text(json.dumps({'idleSeconds': 90, 'waitForUserSeconds': 300}))
    leases = LeaseManager(tmp_path)
    assert leases.idle_seconds == 90
    assert leases.hold_seconds == 300
    explicit = LeaseManager(tmp_path, idle_seconds=12, hold_seconds=45)
    assert explicit.idle_seconds == 12 and explicit.hold_seconds == 45
    policy.write_text(json.dumps({'idleSeconds': 0, 'waitForUserSeconds': 300}))
    assert LeaseManager(tmp_path, idle_seconds=12).hold_seconds == 300
    policy.write_text(json.dumps({'idleSeconds': 0, 'waitForUserSeconds': 601}))
    with pytest.raises(LeaseError, match='sandbox-policy'):
        LeaseManager(tmp_path)
    policy.write_text('[]')
    with pytest.raises(LeaseError, match='sandbox-policy'):
        LeaseManager(tmp_path)
