import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authorizeRuntimeContextRequest, resolveRuntimeSessionContext, runtimeIdForConfig, writeRuntimeContextFile } from "../src/runtime-session-context.js";
import { updateSessionGroupState } from "../src/session-groups.js";
import type { ServerConfig } from "../src/types.js";

test("runtime session context finds the owning company and fixed project instead of the selected company", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-runtime-context-")));
  const a = join(root, "A"), b = join(root, "B"), project = join(b, "projects", "design");
  await mkdir(a); await mkdir(project, { recursive: true });
  const config = { configPath: join(root, "server.json"), workspaces: [{ id: "a", path: a }, { id: "b", path: b }] } as ServerConfig;
  try {
    const context = await resolveRuntimeSessionContext(config, "ses_b", async path => path.endsWith("/message?limit=200&order=asc") ? [] : { id: "ses_b", directory: project }, async () => null);
    assert.deepEqual(context, { runtimeId: runtimeIdForConfig(config), sessionId: "ses_b", company: b, projectId: "proj:design", projectDirectory: project, ancestors: [] });
    await assert.rejects(() => resolveRuntimeSessionContext(config, "ses_spoofed", async () => ({ id: "ses_b", directory: project }), async () => null));
    const roleDir = join(b, ".opencode", "agent");
    await mkdir(roleDir, { recursive: true });
    await writeFile(join(roleDir, "designer.md"), "---\nmetadata:\n  aiopc:\n    skills: [shared, resident]\n---\n角色。\n");
    const installed = join(project, ".opencode", "skills", "shared");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "---\nname: shared\n---\n项目技能。\n");
    await writeFile(join(project, ".opencode", "skills-lock.json"), JSON.stringify({ version: 1, skills: { shared: { id: "audited-shared", hash: "a".repeat(64) } } }));
    await updateSessionGroupState(config, "b", state => ({ ...state, sessionMeta: { ses_b: { agentName: "designer", projectId: "proj:design" } } }));
    const assigned = await resolveRuntimeSessionContext(config, "ses_b", async () => ({ id: "ses_b", directory: project, agent: "untrusted-agent" }), async () => null);
    assert.equal(assigned.agentName, "designer");
    assert.deepEqual(assigned.roleSkills, { resident: ["shared", "resident"], adopted: ["shared"] });

  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime context file has a scoped private credential and never contains the full host token", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-runtime-secret-")));
  const config = { hostToken: "full-host-secret", configPath: join(root, "server.json") } as ServerConfig;
  const file = join(root, "runtime-context.json");
  try {
    await writeRuntimeContextFile(config, "http://127.0.0.1:12345/runtime/session-context", file);
    const raw = await readFile(file, "utf8"), value = JSON.parse(raw);
    assert.ok(!raw.includes(config.hostToken)); assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(value.runtimeId, runtimeIdForConfig(config));
    assert.equal(authorizeRuntimeContextRequest(new Request(value.url, { headers: { "x-aiopc-runtime-token": value.token } }), config), true);
    assert.equal(authorizeRuntimeContextRequest(new Request(value.url, { headers: { "x-aiopc-runtime-token": "wrong" } }), config), false);
    assert.equal(authorizeRuntimeContextRequest(new Request(value.url, { headers: { "x-openwork-host-token": config.hostToken } }), config), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("trusted runtime context HTTP accepts only host/scoped credentials and cleans its private file", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-runtime-http-")));
  const company = join(root, "company"), project = join(company, "projects", "A");
  await mkdir(project, { recursive: true });
  const values = { AIOPC_HOME: root, AIOPC_HTTP_CONNECTION_FILE: join(root, "http.json"), OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"), OPENCODE_DB: join(root, "missing.sqlite"),
    OPENWORK_DATA_DIR: join(root, "data"), OPENWORK_ENGINE_AUTO_UPGRADE: "0", OPENWORK_ENGINE_V2: "0" };
  const previous = new Map(Object.keys(values).concat("AIOPC_RUNTIME_CONTEXT_FILE").map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const releases: any[] = [];
  const opc = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    assert.equal(request.headers.get("authorization"), "Bearer opc-secret");
    assert.ok(request.headers.get("x-aiopc-runtime-token"));
    releases.push(await request.json()); return Response.json({ ok: true });
  } });
  await writeFile(values.AIOPC_HTTP_CONNECTION_FILE, JSON.stringify({ url: `http://127.0.0.1:${opc.port}`, token: "opc-secret" }), { mode: 0o600 });
  let nativeEvents: ReadableStreamDefaultController<Uint8Array> | undefined;
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/global/event") return new Response(new ReadableStream({ start(controller) {
      nativeEvents = controller;
      request.signal.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true });
    } }), { headers: { "Content-Type": "text/event-stream" } });
    if (path === "/session/ses_child") return Response.json({ id: "ses_child", parentID: "ses_parent", directory: project });
    if (path === "/session/ses_parent") return Response.json({ id: "ses_parent", directory: project });
    if (path.endsWith("/message") || ["/session", "/question", "/permission"].includes(path)) return Response.json([]);
    if (path === "/session/status") return Response.json({});
    return new Response(null, { status: 404 });
  } });
  const config = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"),
    externalOpencode: true, opencodeBaseUrl: `http://127.0.0.1:${engine.port}`, engineAutoUpgrade: false,
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [{ id: "company", name: "company", path: company,
      preset: "starter", workspaceType: "local", baseUrl: `http://127.0.0.1:${engine.port}` }], authorizedRoots: [root], readOnly: true,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false } as ServerConfig;
  const { startServer } = await import("../src/server.js");
  const host = await startServer(config);
  let file = "";
  try {
    const url = `http://127.0.0.1:${host.port}/runtime/session-context`;
    const call = (headers: Record<string, string>) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ sessionId: "ses_child", project: "/spoofed" }) });
    assert.equal((await call({ Authorization: "Bearer test" })).status, 401);
    const result = await call({ "x-openwork-host-token": "host" });
    assert.equal(result.status, 200);
    const value = await result.json();
    assert.equal(value.projectDirectory, project); assert.deepEqual(value.ancestors, ["ses_parent"]);
    file = process.env.AIOPC_RUNTIME_CONTEXT_FILE!;
    const secret = JSON.parse(await readFile(file, "utf8"));
    assert.equal(secret.url, url); assert.equal(secret.runtimeId, value.runtimeId);
    assert.equal((await call({ "x-aiopc-runtime-token": secret.token })).status, 200);
    const denied = await fetch(`http://127.0.0.1:${host.port}/runtime/activity`, { headers: { "x-aiopc-runtime-token": secret.token } });
    assert.equal(denied.status, 401);
    for (let i = 0; !nativeEvents && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(nativeEvents, "background host subscribes even with no renderer SSE");
    nativeEvents.enqueue(new TextEncoder().encode('data: {"payload":{"type":"session.idle","properties":{"sessionID":"ses_child"}}}\n\n'));
    for (let i = 0; !releases.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(releases[0]?.sessionId, "ses_child"); assert.equal(releases[0]?.reason, "turn_end");
    assert.equal(releases[0]?.runtimeId, value.runtimeId);
  } finally {
    await host.stop(); engine.stop(true); opc.stop(true);
    assert.equal(releases.at(-1)?.reason, "runtime_stop");
    if (file) await assert.rejects(() => stat(file));
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
