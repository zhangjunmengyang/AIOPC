import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createV2SessionHomes } from "../src/opencode-v2-session-home.js";
import { listSkills } from "../src/skills.js";
import { proxyOpencodeRequest } from "../src/server.js";
import type { ServerConfig, WorkspaceInfo } from "../src/types.js";
import { clearEnginePoolForConfig, setEnginePoolForConfig, type EnginePool } from "../src/engine-pool.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-company-review-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const company = join(root, "company");
  const project = join(company, "projects", "alpha");
  await mkdir(project, { recursive: true });
  const config = { configPath: join(root, "server.json") } as ServerConfig;
  return { root, company, project, config };
}

test("discovering a child first cannot strand its parent under the project home", async (t) => {
  const f = await fixture(t);
  const parent = { id: "ses_review_parent", location: { directory: f.project } };
  const child = { id: "ses_review_child", parentID: parent.id, location: { directory: f.project } };
  const homes = createV2SessionHomes(f.config, async path => {
    if (path === `/api/session/${parent.id}`) return { data: parent };
    if (path.includes("/message?")) return { data: [], cursor: { next: null } };
    throw new Error(`Unexpected read: ${path}`);
  }, async () => null);
  assert.equal(await homes.resolveCompany(child, f.company), f.company);
  assert.equal(await homes.resolveCompany(parent, f.company), f.company);
  assert.deepEqual(new Set(await homes.list(f.company)), new Set([parent.id, child.id]));
});

test("company skill boundary is canonical even when the registered company path is an alias", async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, "company-alias");
  await symlink(f.company, alias);
  for (const [directory, name] of [[f.root, "outside-company"], [f.company, "shared"], [f.project, "project-only"]]) {
    const folder = join(directory!, ".opencode", "skills", name!);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: review fixture\n---\nContent\n`);
  }
  assert.deepEqual((await listSkills(f.project, false, alias)).map(item => item.name).sort(), ["project-only", "shared"]);
});

test("existing external v1 project sessions can be listed without a local v1 origin database", async (t) => {
  const f = await fixture(t);
  const previous = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = join(f.root, "missing-v1.sqlite");
  t.after(async () => { if (previous === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previous; });
  const session = { id: "ses_review_external_v1", directory: f.project, title: "Existing project chat" };
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/session") return Response.json(url.searchParams.get("directory") === f.project ? [session] : []);
    if (url.pathname === `/session/${session.id}`) return Response.json(session);
    if (url.pathname === `/session/${session.id}/message`) return Response.json([]);
    return new Response(null, { status: 404 });
  } });
  t.after(async () => { engine.stop(true); });
  const workspace: WorkspaceInfo = { id: "company", name: "company", path: f.company,
    preset: "starter", workspaceType: "local", baseUrl: `http://127.0.0.1:${engine.port}` };
  const config = { ...f.config, host: "127.0.0.1", port: 0, token: "test", hostToken: "test", externalOpencode: true,
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [f.root], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false } as ServerConfig;
  const url = new URL("http://host/workspace/company/opencode/session");
  const response = await proxyOpencodeRequest({ config, request: new Request(url), url, workspace, proxyPath: "/opencode/session" });
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.deepEqual(listed.map((item: { id: string }) => item.id), [session.id]);
  assert.equal(listed[0].executionDirectory, f.project);
});

test("v1 company event stream keeps message updates using info.sessionID instead of the message ID", async (t) => {
  const f = await fixture(t);
  const sessionId = "ses_review_stream";
  const homes = createV2SessionHomes(f.config, async () => { throw new Error("History is not needed"); });
  await homes.created(sessionId, f.company);
  const event = { directory: f.project, payload: { type: "message.updated", properties: {
    info: { id: "msg_review_stream", sessionID: sessionId, role: "assistant", time: { created: 1 } },
  } } };
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/global/event") return new Response(`data: ${JSON.stringify(event)}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
    return new Response(null, { status: 404 });
  } });
  t.after(async () => { engine.stop(true); });
  const workspace: WorkspaceInfo = { id: "company", name: "company", path: f.company,
    preset: "starter", workspaceType: "local", baseUrl: `http://127.0.0.1:${engine.port}` };
  const config = { ...f.config, host: "127.0.0.1", port: 0, token: "test", hostToken: "test", externalOpencode: true,
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [f.root], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false } as ServerConfig;
  const url = new URL("http://host/workspace/company/opencode/event");
  const response = await proxyOpencodeRequest({ config, request: new Request(url), url, workspace, proxyPath: "/opencode/event" });
  const text = await response.text();
  assert.ok(text.includes('"message.updated"'), text);
  assert.ok(text.includes('"msg_review_stream"'), text);
});

for (const endpoint of ["question", "permission", "session/status"]) {
  test(`v1 company ${endpoint} includes project requests and excludes a foreign company's requests`, async (t) => {
    const f = await fixture(t);
    const sessionId = "ses_review_pending";
    const foreignId = "ses_review_foreign";
    const homes = createV2SessionHomes(f.config, async () => { throw new Error("History is not needed"); });
    await homes.created(sessionId, f.company);
    await homes.created(foreignId, f.root);
    const session = { id: sessionId, directory: f.project, title: "Project session" };
    const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      const projectRequest = url.searchParams.get("directory") === f.project;
      if (url.pathname === `/${endpoint}`) {
        const owner = projectRequest ? sessionId : foreignId;
        return Response.json(endpoint === "session/status" ? { [owner]: { type: "busy" } }
          : [{ id: `request_${owner}`, sessionID: owner }]);
      }
      if (url.pathname === "/session") return Response.json(projectRequest ? [session] : []);
      if (url.pathname === `/session/${sessionId}`) return Response.json(session);
      return new Response(null, { status: 404 });
    } });
    t.after(async () => { engine.stop(true); });
    const workspace: WorkspaceInfo = { id: "company", name: "company", path: f.company,
      preset: "starter", workspaceType: "local", baseUrl: `http://127.0.0.1:${engine.port}` };
    const config = { ...f.config, host: "127.0.0.1", port: 0, token: "test", hostToken: "test", externalOpencode: true,
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [f.root], readOnly: false,
      startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false } as ServerConfig;
    const url = new URL(`http://host/workspace/company/opencode/${endpoint}`);
    const response = await proxyOpencodeRequest({ config, request: new Request(url), url, workspace, proxyPath: `/opencode/${endpoint}` });
    const result = await response.json();
    assert.deepEqual(endpoint === "session/status" ? Object.keys(result) : result.map((item: { sessionID: string }) => item.sessionID), [sessionId]);
  });
}

for (const [kind, action] of [["question", "reply"], ["question", "reject"], ["permission", "reply"]]) {
  test(`v1 ${kind} ${action} reaches its project's instance and refuses foreign requests`, async (t) => {
    const f = await fixture(t);
    const session = { id: "ses_review_reply", directory: f.project, title: "Project question" };
    const homes = createV2SessionHomes(f.config, async () => { throw new Error("History is not needed"); });
    await homes.created(session.id, f.company);
    await homes.created("ses_foreign_reply", f.root);
    const writes: string[] = [];
    const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      const directory = url.searchParams.get("directory") ?? "";
      if (request.method === "POST") { writes.push(directory); return Response.json(true); }
      if (url.pathname === `/${kind}`) return Response.json(directory === f.project
        ? [{ id: "request_own", sessionID: session.id }] : [{ id: "request_foreign", sessionID: "ses_foreign_reply" }]);
      if (url.pathname === `/session/${session.id}`) return Response.json(session);
      return new Response(null, { status: 404 });
    } });
    t.after(async () => { engine.stop(true); });
    const workspace: WorkspaceInfo = { id: "company", name: "company", path: f.company,
      preset: "starter", workspaceType: "local", baseUrl: `http://127.0.0.1:${engine.port}` };
    const config = { ...f.config, host: "127.0.0.1", port: 0, token: "test", hostToken: "test", externalOpencode: true,
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [f.root], readOnly: false,
      startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false } as ServerConfig;
    const call = async (id: string) => {
      const url = new URL(`http://host/workspace/company/opencode/${kind}/${id}/${action}`);
      const request = new Request(url, { method: "POST", body: JSON.stringify({ answers: [["yes"]], reply: "once" }) });
      return proxyOpencodeRequest({ config, request, url, workspace, proxyPath: `/opencode/${kind}/${id}/${action}` });
    };
    assert.equal((await call("request_own")).status, 200);
    assert.deepEqual(writes, [f.project]);
    await assert.rejects(call("request_foreign"), (error: any) => error.status === 404);
    assert.deepEqual(writes, [f.project]);
  });
}

test("pooled pending replies keep both the draining generation and a moved session's execution directory", async (t) => {
  const f = await fixture(t);
  const moved = join(f.root, "worktree");
  await mkdir(moved);
  const session = { id: "ses_review_draining", directory: moved, title: "Moved project session" };
  const homes = createV2SessionHomes(f.config, async () => { throw new Error("History is not needed"); });
  await homes.created(session.id, f.company);
  await homes.created("ses_pool_foreign", f.root);
  const writes: Array<{ generation: string; directory: string }> = [];
  const engines = ["primary", "draining"].map(generation => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url), directory = url.searchParams.get("directory") ?? "";
    if (request.method === "POST") { writes.push({ generation, directory }); return Response.json(true); }
    if (url.pathname === `/session/${session.id}`) return generation === "draining" ? Response.json(session) : new Response(null, { status: 404 });
    if (url.pathname === "/question") return Response.json(generation === "draining" && directory === moved
      ? [{ id: "req_draining", sessionID: session.id }] : [{ id: "req_foreign", sessionID: "ses_pool_foreign" }]);
    return new Response(null, { status: 404 });
  } }));
  t.after(async () => { engines.forEach(engine => engine.stop(true)); });
  const connections = engines.map((engine, index) => ({ generationId: index ? "draining" : "primary",
    role: index ? "draining" : "primary", baseUrl: `http://127.0.0.1:${engine.port}`, username: "test", password: "test" }));
  let requestLocated = false;
  const pool = {
    routeRequest: (_method: string, path: string) => ({ target: connections[path.includes(session.id) || (path.includes("req_draining") && requestLocated) ? 1 : 0], fallback: null }),
    connections: () => connections,
    observePendingRequests: (generation: string, payload: any) => {
      if (generation === "draining" && Array.isArray(payload) && payload.some(item => item.id === "req_draining")) requestLocated = true;
    },
    reportRequestSuccess: () => undefined,
  } as unknown as EnginePool;
  const workspace: WorkspaceInfo = { id: "company", name: "company", path: f.company,
    preset: "starter", workspaceType: "local", baseUrl: connections[0]!.baseUrl };
  const config = { ...f.config, host: "127.0.0.1", port: 0, token: "test", hostToken: "test", externalOpencode: true,
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [f.root], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false } as ServerConfig;
  setEnginePoolForConfig(config, pool);
  t.after(async () => { clearEnginePoolForConfig(config); });
  const url = new URL("http://host/workspace/company/opencode/question/req_draining/reply");
  const request = new Request(url, { method: "POST", body: JSON.stringify({ answers: [["yes"]] }) });
  const response = await proxyOpencodeRequest({ config, request, url, workspace, proxyPath: "/opencode/question/req_draining/reply" });
  assert.equal(response.status, 200);
  assert.deepEqual(writes, [{ generation: "draining", directory: moved }]);
});
