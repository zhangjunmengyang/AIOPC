import assert from "node:assert/strict";
import { test } from "node:test";
import { createAiopcLeaseLifecycle, createAiopcLeaseReleaser, leaseLifecycleEvent } from "../src/aiopc-lease-lifecycle.js";

test("lease lifecycle recognizes native v1/v2 completion, abort and deletion only", () => {
  assert.deepEqual(leaseLifecycleEvent({ payload: { type: "session.idle", properties: { sessionID: "ses_a" } } }), { sessionId: "ses_a", reason: "turn_end" });
  assert.deepEqual(leaseLifecycleEvent({ type: "session.execution.interrupted", data: { sessionID: "ses_b" } }), { sessionId: "ses_b", reason: "abort" });
  assert.deepEqual(leaseLifecycleEvent({ type: "session.deleted", properties: { info: { id: "ses_c" } } }), { sessionId: "ses_c", reason: "deleted" });
  assert.deepEqual(leaseLifecycleEvent({ type: "session.updated", properties: { info: { id: "ses_c", time: { archived: 1 } } } }), { sessionId: "ses_c", reason: "deleted" });
  assert.equal(leaseLifecycleEvent({ type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } }), null);
  assert.equal(leaseLifecycleEvent({ type: "message.updated", properties: { info: { id: "msg_a", sessionID: "ses_a" } } }), null);
});

test("background native subscription releases without any renderer connection and stops cleanly", async () => {
  const released: unknown[] = [];
  let send: ReadableStreamDefaultController<Uint8Array> | undefined;
  const lifecycle = createAiopcLeaseLifecycle({
    targets: () => [{ key: "engine-v1", url: "http://127.0.0.1:123/global/event", headers: {} }],
    fetchImpl: async (_url, options) => new Response(new ReadableStream({ start(controller) {
      send = controller; options?.signal?.addEventListener("abort", () => controller.close(), { once: true });
    } })),
    release: async value => { released.push(value); }, pollMs: 5,
  });
  try {
    for (let i=0; !send && i<100; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(send);
    send.enqueue(new TextEncoder().encode('data: {"payload":{"type":"session.idle","properties":{"sessionID":"ses_native"}}}\n\n'));
    for (let i=0; !released.length && i<100; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal((released[0] as any).sessionId, "ses_native"); assert.equal((released[0] as any).reason, "turn_end");
    assert.ok((released[0] as any).observedAt <= Date.now());
  } finally { await lifecycle.stop(); }
  assert.equal((released.at(-1) as any).reason, "runtime_stop");
});


test("lease release uses the private HTTP descriptor and a separate runtime capability", async () => {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "aiopc-lease-release-"));
  const calls: { headers: Headers; body: any }[] = [];
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls.push({ headers: request.headers, body: await request.json() }); return Response.json({ ok: true });
  } });
  try {
    const file = join(root, "connection.json");
    await writeFile(file, JSON.stringify({ url: `http://127.0.0.1:${http.port}`, token: "http-secret" }), { mode: 0o600 });
    const release = createAiopcLeaseReleaser({ hostToken: "full-host-secret" } as any, file);
    await release({ sessionId: "ses_done", reason: "turn_end", observedAt: 123 });
    assert.equal(calls[0].headers.get("authorization"), "Bearer http-secret");
    assert.ok(calls[0].headers.get("x-aiopc-runtime-token"));
    assert.notEqual(calls[0].headers.get("x-aiopc-runtime-token"), "full-host-secret");
    assert.equal(calls[0].body.observedAt, 123);
    await chmod(file, 0o644);
    await assert.rejects(() => release({ reason: "runtime_stop" }), /Insecure/);
    assert.equal(calls.length, 1);
  } finally { http.stop(true); await rm(root, { recursive: true, force: true }); }
});
