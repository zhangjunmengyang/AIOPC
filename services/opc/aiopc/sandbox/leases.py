"""Shared browser leases and operation mutexes for HTTP, MCP and desktop callers."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import sqlite3
import time
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager, contextmanager, suppress
from contextvars import ContextVar
from pathlib import Path

_operations: ContextVar[dict | None] = ContextVar("aiopc_browser_operations", default=None)


class LeaseError(ValueError):
    def __init__(self, message: str, code: str = "lease_invalid"):
        super().__init__(message)
        self.code = code


class LeaseManager:
    def __init__(self, home: Path, *, idle_seconds=None, hold_seconds=None, operation_seconds=30,
                 queue_seconds=600, clock: Callable = time.time, binding_resolver: Callable | None = None):
        self.home = Path(home)
        self.home.mkdir(parents=True, exist_ok=True)
        self.path = self.home / "sandbox-leases.sqlite"
        policy = {}
        policy_path = self.home / "sandbox-policy.json"
        if (idle_seconds is None or hold_seconds is None) and policy_path.exists():
            try:
                policy = json.loads(policy_path.read_text())
                if not isinstance(policy, dict):
                    raise TypeError("expected an object")
                for key, maximum, explicit in (("idleSeconds", 3600, idle_seconds), ("waitForUserSeconds", 600, hold_seconds)):
                    if explicit is None and key in policy and (isinstance(policy[key], bool) or not isinstance(policy[key], (int, float))
                                          or not 5 <= policy[key] <= maximum):
                        raise ValueError(f"{key} must be between 5 and {maximum}")
            except (OSError, TypeError, ValueError) as exc:
                raise LeaseError(f"sandbox-policy.json 租约配置无效：{exc}", "lease_policy_invalid") from exc
        idle_seconds = idle_seconds if idle_seconds is not None else policy.get("idleSeconds", 60)
        hold_seconds = hold_seconds if hold_seconds is not None else policy.get("waitForUserSeconds", 600)
        self.idle_seconds, self.hold_seconds = float(idle_seconds), float(hold_seconds)
        self.operation_seconds, self.queue_seconds = float(operation_seconds), float(queue_seconds)
        durations = (self.idle_seconds, self.hold_seconds, self.operation_seconds, self.queue_seconds)
        if not all(math.isfinite(value) and value > 0 for value in durations):
            raise ValueError("租约时长必须大于零")
        self.clock, self.binding_resolver = clock, binding_resolver
        with self._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS leases(env TEXT PRIMARY KEY, id TEXT NOT NULL, owner_key TEXT NOT NULL,
                    owner TEXT NOT NULL, revision INTEGER NOT NULL, expires REAL NOT NULL, hold_started REAL);
                CREATE TABLE IF NOT EXISTS waiters(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                    env TEXT NOT NULL, owner_key TEXT NOT NULL, owner TEXT NOT NULL, revision INTEGER NOT NULL,
                    priority INTEGER NOT NULL, expires REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS waiter_env ON waiters(env, priority DESC, seq);
                CREATE TABLE IF NOT EXISTS operations(env TEXT PRIMARY KEY, id TEXT NOT NULL, lease_id TEXT NOT NULL, owner_key TEXT NOT NULL,
                    expires REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS revoked_runtimes(id TEXT PRIMARY KEY);
            """)
            # executescript commits the transaction opened by _db. Re-enter it
            # before checking columns so parallel HTTP/MCP startup cannot race ALTER.
            if not db.in_transaction:
                db.execute("BEGIN IMMEDIATE")
            for table, column, definition in (("leases", "last_activity", "REAL NOT NULL DEFAULT 0"),
                                               ("waiters", "last_activity", "REAL NOT NULL DEFAULT 0"),
                                               ("operations", "owner_key", "TEXT NOT NULL DEFAULT ''"),
                                               ("operations", "owner_json", "TEXT NOT NULL DEFAULT '{}'")):
                if column not in {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        os.chmod(self.path, 0o600)

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA busy_timeout=10000")
            db.execute("BEGIN IMMEDIATE")
            yield db
            if db.in_transaction:
                db.execute("COMMIT")
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    def _clean(self, db):
        now = self.clock()
        db.execute("DELETE FROM operations WHERE expires<=?", (now,))
        db.execute("DELETE FROM leases WHERE expires<=? AND env NOT IN (SELECT env FROM operations)", (now,))
        db.execute("DELETE FROM waiters WHERE expires<=?", (now,))

    @staticmethod
    def _owner(owner):
        fields = [owner.get(key) for key in ("runtimeId", "sessionId", "company")]
        if not all(isinstance(value, str) and value for value in fields):
            raise LeaseError("浏览器操作缺少可信会话归属", "runtime_context_required")
        kind = owner.get("kind", "automation")
        if kind not in {"automation", "human"}:
            raise LeaseError("无效的浏览器使用者")
        value = {**owner, "kind": kind, "label": str(owner.get("label") or owner["sessionId"])[:256]}
        identity = json.dumps([*fields, kind], ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(identity.encode()).hexdigest(), json.dumps(value, ensure_ascii=False)

    def _binding(self, env, owner, revision):
        if not isinstance(env, str) or not env or not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
            raise LeaseError("无效的环境绑定")
        if self.binding_resolver:
            binding = self.binding_resolver(env)
            if binding.get("bindingRevision") != revision:
                raise LeaseError("环境绑定已经变化，请重新选择环境", "binding_changed")
            company = str(Path(owner["company"]).resolve())
            if str(Path(binding["company"]).resolve()) != company:
                raise LeaseError("环境不属于此会话的公司归属", "environment_forbidden")
            bound = binding.get("boundProject")
            requested = owner.get("projectDirectory")
            if (bound is None and owner.get("kind", "automation") != "human") or (bound is not None
                    and (not requested or str(Path(bound).resolve()) != str(Path(requested).resolve()))):
                raise LeaseError("环境不属于此会话的项目归属", "environment_forbidden")

    def _lease(self, db, env, owner, lease_id, revision=None):
        self._clean(db)
        key, _ = self._owner(owner)
        row = db.execute("SELECT * FROM leases WHERE env=?", (env,)).fetchone()
        if not row or row["id"] != lease_id or row["owner_key"] != key:
            raise LeaseError("浏览器租约已结束或已交给其他使用者", "lease_lost")
        self._binding(env, owner, row["revision"] if revision is None else revision)
        if revision is not None and row["revision"] != revision:
            raise LeaseError("环境绑定已经变化", "binding_changed")
        return row

    @staticmethod
    def _holder(row):
        if not row:
            return None
        owner = json.loads(row["owner"])
        return {"ownerKey": row["owner_key"], "kind": owner["kind"], "sessionId": owner["sessionId"],
                "label": owner["label"], "expiresAt": round(row["expires"] * 1000), "waitingForUser": row["hold_started"] is not None}

    def _snapshot(self, db, env):
        row = db.execute("SELECT * FROM leases WHERE env=?", (env,)).fetchone()
        queue = db.execute("SELECT * FROM waiters WHERE env=? ORDER BY priority DESC,seq", (env,)).fetchall()
        return {"holder": self._holder(row), "queue": [
            {"requestId": item["id"], "kind": json.loads(item["owner"])["kind"],
             "label": json.loads(item["owner"])["label"], "position": index + 1}
            for index, item in enumerate(queue)], "bindingRevision": row["revision"] if row else None}

    def status(self, env):
        with self._db() as db:
            self._clean(db)
            value = self._snapshot(db, env)
            if self.binding_resolver:
                value["bindingRevision"] = self.binding_resolver(env).get("bindingRevision")
            return value

    def acquire(self, env, owner, binding_revision, *, request_id=None):
        key, encoded = self._owner(owner)
        self._binding(env, owner, binding_revision)
        request_id = request_id or str(uuid.uuid4())
        with self._db() as db:
            self._binding(env, owner, binding_revision)
            if owner.get("kind", "automation") == "automation" and db.execute("SELECT 1 FROM revoked_runtimes WHERE id=?", (owner["runtimeId"],)).fetchone():
                raise LeaseError("此运行时已经结束，请重新打开会话", "runtime_closed")
            self._clean(db)
            row = db.execute("SELECT * FROM leases WHERE env=?", (env,)).fetchone()
            operation = db.execute("SELECT * FROM operations WHERE env=?", (env,)).fetchone()
            if row and row["revision"] != binding_revision:
                db.execute("DELETE FROM leases WHERE env=?", (env,))
                row = None
            db.execute("DELETE FROM waiters WHERE env=? AND revision!=?", (env, binding_revision))
            if row and row["owner_key"] == key:
                db.execute("DELETE FROM waiters WHERE env=? AND owner_key=?", (env, key))
                return {"state": "granted", "leaseId": row["id"], "requestId": request_id,
                        "expiresAt": round(row["expires"] * 1000), **self._snapshot(db, env)}
            if row:
                holder = json.loads(row["owner"])
                if holder["sessionId"] in owner.get("ancestors", []) or owner["sessionId"] in holder.get("ancestors", []):
                    raise LeaseError("父子会话不能互相等待同一浏览器，请先交还环境", "lease_nested_owner")
                if owner.get("kind") == "human" and holder["kind"] != "human" and not operation:
                    db.execute("DELETE FROM leases WHERE env=?", (env,))
                    row = None
            previous = db.execute("SELECT * FROM waiters WHERE id=?", (request_id,)).fetchone()
            if previous and (previous["owner_key"] != key or previous["env"] != env):
                raise LeaseError("排队请求不属于此会话", "lease_request_invalid")
            db.execute("INSERT INTO waiters(id,env,owner_key,owner,revision,priority,expires,last_activity) VALUES(?,?,?,?,?,?,?,?) "
                       "ON CONFLICT(id) DO UPDATE SET expires=excluded.expires,last_activity=excluded.last_activity",
                       (request_id, env, key, encoded, binding_revision, int(owner.get("kind") == "human"), self.clock() + self.queue_seconds, self.clock()))
            first = db.execute("SELECT id FROM waiters WHERE env=? ORDER BY priority DESC,seq LIMIT 1", (env,)).fetchone()
            if not row and not operation and first["id"] == request_id:
                lease_id, expires = str(uuid.uuid4()), self.clock() + self.idle_seconds
                db.execute("INSERT INTO leases(env,id,owner_key,owner,revision,expires,hold_started,last_activity) VALUES(?,?,?,?,?,?,NULL,?)", (env, lease_id, key, encoded, binding_revision, expires, self.clock()))
                db.execute("DELETE FROM waiters WHERE id=?", (request_id,))
                return {"state": "granted", "leaseId": lease_id, "requestId": request_id,
                        "expiresAt": round(expires * 1000), **self._snapshot(db, env)}
            snapshot = self._snapshot(db, env)
            return {"state": "queued", "requestId": request_id,
                    "position": next(item["position"] for item in snapshot["queue"] if item["requestId"] == request_id), **snapshot}

    def begin_operation(self, env, owner, lease_id, binding_revision, operation_id):
        if not isinstance(operation_id, str) or not operation_id:
            raise LeaseError("浏览器操作缺少标识")
        with self._db() as db:
            self._lease(db, env, owner, lease_id, binding_revision)
            current = db.execute("SELECT * FROM operations WHERE env=?", (env,)).fetchone()
            if current and (current["id"] != operation_id or current["lease_id"] != lease_id):
                return {"state": "busy"}
            key, encoded = self._owner(owner)
            db.execute("INSERT INTO operations(env,id,lease_id,owner_key,expires,owner_json) VALUES(?,?,?,?,?,?) "
                       "ON CONFLICT(env) DO UPDATE SET expires=excluded.expires,owner_json=excluded.owner_json",
                       (env, operation_id, lease_id, key, self.clock() + self.operation_seconds, encoded))
            db.execute("UPDATE leases SET expires=?,hold_started=NULL,last_activity=? WHERE env=?", (self.clock() + self.idle_seconds, self.clock(), env))
            return {"state": "granted", "operationId": operation_id}

    def cleanup_owner(self, env, *, runtime_id, session_id, action, lease_id="", operation_id="", request_id=""):
        """Recover only the existing token-bound owner after native session deletion.

        This cannot grant or renew a lease. The operation retains its owner after
        lifecycle release so cancelling CDP can remove its short mutex promptly.
        """
        with self._db() as db:
            self._clean(db)
            if action == "end" and lease_id and operation_id:
                row = db.execute("SELECT owner_json AS owner FROM operations WHERE env=? AND id=? AND lease_id=?",
                                 (env, operation_id, lease_id)).fetchone()
            elif action == "cancel" and request_id:
                row = db.execute("SELECT owner FROM waiters WHERE env=? AND id=?", (env, request_id)).fetchone()
            else:
                row = None
            owner = json.loads(row["owner"]) if row else {}
            if (owner.get("runtimeId") != runtime_id or owner.get("sessionId") != session_id
                    or owner.get("kind") != "automation" or not runtime_id or not session_id):
                raise LeaseError("清理凭据不属于此会话的浏览器操作", "lease_cleanup_invalid")
            return owner

    def end_operation(self, env, owner, lease_id, operation_id):
        with self._db() as db:
            key, _ = self._owner(owner)
            row = db.execute("SELECT * FROM leases WHERE env=? AND id=? AND owner_key=?", (env, lease_id, key)).fetchone()
            changed = db.execute("DELETE FROM operations WHERE env=? AND id=? AND lease_id=? AND owner_key=?",
                                 (env, operation_id, lease_id, key)).rowcount
            if changed and row:
                if row["hold_started"] is None:
                    db.execute("UPDATE leases SET expires=? WHERE env=?", (self.clock() + self.idle_seconds, env))
                if json.loads(row["owner"])["kind"] != "human" and db.execute(
                        "SELECT 1 FROM waiters WHERE env=? AND priority=1 AND expires>?", (env, self.clock())).fetchone():
                    db.execute("DELETE FROM leases WHERE env=?", (env,))
            return bool(changed)

    def heartbeat(self, env, owner, lease_id, *, operation_id=None, activity=False):
        with self._db() as db:
            row = self._lease(db, env, owner, lease_id)
            if operation_id is not None:
                active = db.execute("SELECT 1 FROM operations WHERE env=? AND id=? AND lease_id=?",
                                    (env, operation_id, lease_id)).fetchone()
                if not active:
                    raise LeaseError("浏览器操作已结束或已被替换", "lease_lost")
                db.execute("UPDATE operations SET expires=? WHERE env=?", (self.clock() + self.operation_seconds, env))
            # A late heartbeat from the operation that opened the QR code
            # must preserve the bounded wait already requested by that operation.
            if row["hold_started"] is None and (operation_id is not None or (activity and owner.get("kind") == "human")):
                now = self.clock()
                db.execute("UPDATE leases SET expires=?,last_activity=? WHERE env=?", (now + self.idle_seconds, now, env))
                row = db.execute("SELECT * FROM leases WHERE env=?", (env,)).fetchone()
            return {"expiresAt": round(row["expires"] * 1000)}

    def wait_for_user(self, env, owner, lease_id):
        with self._db() as db:
            row = self._lease(db, env, owner, lease_id)
            start = row["hold_started"] if row["hold_started"] is not None else self.clock()
            expires = start + self.hold_seconds
            db.execute("UPDATE leases SET hold_started=?,expires=? WHERE env=?", (start, expires, env))
            return {"expiresAt": round(expires * 1000), "waitingForUser": True}

    def release(self, env, owner, lease_id):
        key, _ = self._owner(owner)
        with self._db() as db:
            return bool(db.execute("DELETE FROM leases WHERE env=? AND id=? AND owner_key=?", (env, lease_id, key)).rowcount)

    def cancel(self, env, owner, request_id):
        key, _ = self._owner(owner)
        with self._db() as db:
            return bool(db.execute("DELETE FROM waiters WHERE env=? AND id=? AND owner_key=?", (env, request_id, key)).rowcount)

    def release_owner(self, owner, *, reason="turn_end", observed_at=None):
        key, _ = self._owner(owner)
        with self._db() as db:
            observed = " AND last_activity<=?" if observed_at is not None else ""
            args = (key, float(observed_at) / 1000) if observed_at is not None else (key,)
            db.execute("DELETE FROM waiters WHERE owner_key=?" + observed, args)
            condition = " AND hold_started IS NULL" if reason == "turn_end" else ""
            return db.execute("DELETE FROM leases WHERE owner_key=?" + condition + observed, args).rowcount

    def release_runtime(self, runtime_id, *, session_id=None, reason="turn_end", observed_at=None):
        """Host-authenticated lifecycle cleanup; human leases belong to the viewer."""
        with self._db() as db:
            if reason == "runtime_stop":
                db.execute("INSERT OR IGNORE INTO revoked_runtimes VALUES(?)", (runtime_id,))
            rows = db.execute("SELECT owner_key,owner FROM leases UNION SELECT owner_key,owner FROM waiters").fetchall()
            keys = {row["owner_key"] for row in rows if (value := json.loads(row["owner"])).get("runtimeId") == runtime_id
                    and value.get("kind") == "automation" and (session_id is None or value.get("sessionId") == session_id)}
            count = 0
            observed = " AND last_activity<=?" if observed_at is not None else ""
            condition = " AND hold_started IS NULL" if reason == "turn_end" else ""
            for key in keys:
                args = (key, float(observed_at) / 1000) if observed_at is not None else (key,)
                db.execute("DELETE FROM waiters WHERE owner_key=?" + observed, args)
                count += db.execute("DELETE FROM leases WHERE owner_key=?" + condition + observed, args).rowcount
            return count

    @asynccontextmanager
    async def maintenance(self, env, binding_revision):
        """Internal registry mutation guard; never exposed as a caller owner kind."""
        operation_id = str(uuid.uuid4())
        with self._db() as db:
            self._clean(db)
            if self.binding_resolver and self.binding_resolver(env).get("bindingRevision") != binding_revision:
                raise LeaseError("环境绑定已经变化", "binding_changed")
            if db.execute("SELECT 1 FROM leases WHERE env=? UNION ALL SELECT 1 FROM operations WHERE env=?", (env, env)).fetchone():
                raise LeaseError("环境正在使用，请先交还后再修改", "environment_busy")
            db.execute("INSERT INTO operations(env,id,lease_id,owner_key,expires) VALUES(?,?,?,?,?)", (env, operation_id, "maintenance", "maintenance", self.clock() + self.operation_seconds))
        task = asyncio.current_task()

        async def renew():
            while True:
                await asyncio.sleep(min(5, self.operation_seconds / 3))
                with self._db() as db:
                    changed = db.execute("UPDATE operations SET expires=? WHERE env=? AND id=?",
                                         (self.clock() + self.operation_seconds, env, operation_id)).rowcount
                if not changed:
                    if task:
                        task.cancel()
                    return

        heartbeat = asyncio.create_task(renew())
        try:
            yield
        finally:
            heartbeat.cancel()
            with suppress(asyncio.CancelledError):
                await heartbeat
            with self._db() as db:
                db.execute("DELETE FROM operations WHERE env=? AND id=?", (env, operation_id))

    @asynccontextmanager
    async def operation(self, env, owner, binding_revision):
        task = asyncio.current_task()
        key, _ = self._owner(owner)
        context_key = (str(self.path.resolve()), env)
        previous = (_operations.get() or {}).get(context_key)
        if previous and previous["task"] is task and previous["owner"] == key:
            with self._db() as db:
                self._lease(db, env, owner, previous["value"]["leaseId"], binding_revision)
            yield previous["value"]
            return
        request_id, operation_id = str(uuid.uuid4()), str(uuid.uuid4())
        lease_id = None
        heartbeat = None
        context_token = None

        async def renew():
            try:
                while True:
                    await asyncio.sleep(min(5, self.operation_seconds / 3))
                    self.heartbeat(env, owner, lease_id, operation_id=operation_id)
            except LeaseError:
                if task:
                    task.cancel()

        try:
            while True:
                result = self.acquire(env, owner, binding_revision, request_id=request_id)
                if result["state"] == "granted":
                    lease_id = result["leaseId"]
                    break
                await asyncio.sleep(0.05)
            while self.begin_operation(env, owner, lease_id, binding_revision, operation_id)["state"] != "granted":
                await asyncio.sleep(0.05)
            heartbeat = asyncio.create_task(renew())
            value = {"leaseId": lease_id, "operationId": operation_id}
            context_token = _operations.set({**(_operations.get() or {}), context_key: {"task": task, "owner": key, "value": value}})
            yield value
        finally:
            if context_token is not None:
                _operations.reset(context_token)
            if heartbeat:
                heartbeat.cancel()
                with suppress(asyncio.CancelledError):
                    await heartbeat
            self.cancel(env, owner, request_id)
            if lease_id:
                self.end_operation(env, owner, lease_id, operation_id)
