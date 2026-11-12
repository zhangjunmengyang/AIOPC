import json
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

import pytest

from aiopc.sandbox.leases import LeaseError, LeaseManager


def owner(home, session, kind="automation"):
    company = home / "company"
    return {"runtimeId": "local-test", "sessionId": session, "company": str(company),
            "projectDirectory": str(company / "projects" / "alpha"), "kind": kind}


def until(condition, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if result := condition():
            return result
        time.sleep(0.02)
    raise AssertionError("等待环境租约超时")


@contextmanager
def browser_operation(home, session):
    # Separate processes use the same browser substitute. It fails immediately
    # if two callers try to use it at once.
    busy = home / "browser-busy"
    with busy.open("x"):
        try:
            with (home / "browser-actions.log").open("a", encoding="utf-8") as actions:
                actions.write(f"{session}\n")
            yield
        finally:
            busy.unlink()


def contend(home, session, kind):
    leases = LeaseManager(home)
    identity = owner(home, session, kind)

    def try_acquire():
        result = leases.acquire("primary", identity, 1, request_id=session)
        if result["state"] == "granted":
            return result
        return None

    granted = until(try_acquire)
    lease = granted["leaseId"]
    try:
        assert leases.begin_operation("primary", identity, lease, 1, session)["state"] == "granted"
        with browser_operation(home, session):
            time.sleep(0.03)
        assert leases.end_operation("primary", identity, lease, session)
    finally:
        leases.release("primary", identity, lease)
    print(json.dumps({"session": session, "lease": lease}), flush=True)


def test_process_contention_keeps_browser_exclusive_and_respects_queue(tmp_path):
    leases = LeaseManager(tmp_path)
    holder = owner(tmp_path, "holder")
    original = leases.acquire("primary", holder, 1)["leaseId"]
    assert leases.begin_operation("primary", holder, original, 1, "initial")["state"] == "granted"
    workers = {}

    def start(session, kind="automation"):
        test_file = Path(__file__).resolve()
        worker = "import runpy, sys; sys.path.insert(0, sys.argv.pop(1)); runpy.run_path(sys.argv.pop(1), run_name='__main__')"
        workers[session] = subprocess.Popen(
            [sys.executable, "-I", "-c", worker, str(test_file.parents[1]), str(test_file), str(tmp_path), session, kind],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )

    def queue():
        for session, process in workers.items():
            if process.poll() is not None:
                stdout, stderr = process.communicate()
                pytest.fail(f"{session} 提前退出（{process.returncode}）\n{stdout}\n{stderr}")
        return [item["requestId"] for item in leases.status("primary")["queue"]]

    try:
        with browser_operation(tmp_path, "holder"):
            for index in range(8):
                start(f"session-{index}")

            def all_queued():
                pending = queue()
                return pending if len(pending) == 8 else None

            fifo = until(all_queued)
            start("human", "human")
            until(lambda: queue() == ["human", *fifo])

            # The primary browser is in use, but a different environment in the
            # same company must remain available.
            other = leases.acquire("secondary", holder, 1)["leaseId"]
            assert leases.begin_operation("secondary", holder, other, 1, "secondary-action")["state"] == "granted"
            assert leases.end_operation("secondary", holder, other, "secondary-action")
            assert leases.release("secondary", holder, other)

        assert leases.end_operation("primary", holder, original, "initial")
        leases.release_owner(holder)
        completed = []
        for session, process in workers.items():
            stdout, stderr = process.communicate(timeout=20)
            assert process.returncode == 0, f"{session}\n{stdout}\n{stderr}"
            result = json.loads(stdout)
            assert result["session"] == session
            completed.append(result["lease"])
        assert len(set(completed)) == len(workers)
        assert (tmp_path / "browser-actions.log").read_text().splitlines() == ["holder", "human", *fifo]
        state = leases.status("primary")
        assert state["holder"] is None and state["queue"] == []
    finally:
        for process in workers.values():
            if process.poll() is None:
                process.kill()
            process.communicate()


def test_expired_operation_cannot_renew_replacement_operation(tmp_path):
    now = [1000.0]
    leases = LeaseManager(tmp_path, clock=lambda: now[0])
    identity = owner(tmp_path, "session")
    lease = leases.acquire("primary", identity, 1)["leaseId"]
    assert leases.begin_operation("primary", identity, lease, 1, "original")["state"] == "granted"
    now[0] += 31
    assert leases.begin_operation("primary", identity, lease, 1, "replacement")["state"] == "granted"
    with pytest.raises(LeaseError):
        leases.heartbeat("primary", identity, lease, operation_id="original")
    assert leases.heartbeat("primary", identity, lease, operation_id="replacement")["expiresAt"] == 1_091_000


def test_in_flight_operation_heartbeat_preserves_scan_hold_after_turn_ends(tmp_path):
    now = [1000.0]
    leases = LeaseManager(tmp_path, clock=lambda: now[0])
    identity = owner(tmp_path, "session")
    lease = leases.acquire("primary", identity, 1)["leaseId"]
    assert leases.begin_operation("primary", identity, lease, 1, "open-qr")["state"] == "granted"
    hold = leases.wait_for_user("primary", identity, lease)
    now[0] += 5
    heartbeat = leases.heartbeat("primary", identity, lease, operation_id="open-qr")
    assert leases.end_operation("primary", identity, lease, "open-qr")
    assert heartbeat["expiresAt"] == hold["expiresAt"]
    assert leases.release_owner(identity, reason="turn_end") == 0
    assert leases.status("primary")["holder"]["waitingForUser"]
    now[0] += 595
    assert leases.status("primary")["holder"] is None


if __name__ == "__main__":
    contend(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
