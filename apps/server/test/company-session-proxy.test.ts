import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proxyOpencodeRequest, proxyOpencodeV2Request } from "../src/server.js";
import type { ServerConfig, WorkspaceInfo } from "../src/types.js";
import { readSessionGroupState, updateSessionGroupState } from "../src/session-groups.js";

test("both engines execute project sessions below their company and restore them in company lists", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-company-proxy-")));
  const company = join(root, "company");
  const a = join(company, "projects", "A");
  const b = join(company, "projects", "B");
  await mkdir(a, { recursive: true }); await mkdir(b);
  const previous = { runtime: process.env.OPENWORK_RUNTIME_DB, database: process.env.OPENCODE_DB };
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.OPENCODE_DB = join(root, "v1.sqlite");
  const sessions = new Map<string, { id: string; directory: string; title: string; location: { directory: string } }>();
  const prompts: Array<{ id: string; directory: string; body: unknown }> = [];
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "");
    const directory = url.searchParams.get("location[directory]") ?? url.searchParams.get("directory") ?? "";
    const v2 = url.pathname.startsWith("/api/");
    const response = (value: unknown) => Response.json(v2 ? { data: value } : value);
    if (path === "/event" || path === "/global/event") {
      const events = [...sessions.values()].map(session => v2
        ? { type: "session.created", location: { directory: session.directory }, data: { ...session, sessionID: session.id } }
        : { directory: session.directory, payload: { type: "session.created", properties: { info: session } } });
      events.push(v2
        ? { type: "session.created", location: { directory: root }, data: { id: "ses_other", sessionID: "ses_other", directory: root, title: "foreign", location: { directory: root } } }
        : { directory: root, payload: { type: "session.created", properties: { info: { id: "ses_other", directory: root, title: "foreign", location: { directory: root } } } } });
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (path === "/session" && request.method === "POST") {
      const body = await request.json() as { location?: { directory?: string }; title?: string };
      const execution = v2 ? body.location?.directory ?? directory : directory;
      const session = { id: `ses_company_${sessions.size}`, directory: execution, title: body.title ?? "test", location: { directory: execution } };
      sessions.set(session.id, session);
      return response(session);
    }
    if (path === "/session") return response([...sessions.values()].filter(item => item.directory === directory));
    const id = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (id?.[1] && sessions.has(id[1])) {
      if (!id[2]) return response(sessions.get(id[1]));
      if (id[2] === "fork" && request.method === "POST") {
        const fork = { ...sessions.get(id[1])!, id: `ses_company_${sessions.size}`, parentID: id[1] };
        sessions.set(fork.id, fork);
        return response(fork);
      }
      if (id[2] === "message" && request.method === "GET") return response(id[1] === "ses_foreign_moved"
        ? [{ type: "location-switched", previous: { location: { directory: root } } }] : []);
      if (id[2] === "prompt" || id[2] === "prompt_async") {
        prompts.push({ id: id[1], directory, body: await request.json() });
        return response(true);
      }
    }
    if (path.includes("/instructions/entries/")) return response(true);
    return new Response(null, { status: 404 });
  } });
  const baseUrl = `http://127.0.0.1:${engine.port}`;
  const workspace: WorkspaceInfo = { id: "company", name: "company", path: company, preset: "starter", workspaceType: "local", baseUrl };
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [root], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false };
  const call = async (v2: boolean, method: string, path: string, body?: unknown, directory = company) => {
    const proxyPath = `${v2 ? "/opencode2/api" : "/opencode"}${path}`;
    const url = new URL(`http://host${proxyPath}`);
    url.searchParams.set(v2 ? "location[directory]" : "directory", directory);
    const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
    const response = v2 ? await proxyOpencodeV2Request({ actor: { type: "host" }, config, request, url, workspace, proxyPath,
      connection: { url: baseUrl, username: "opencode", password: "test" } })
      : await proxyOpencodeRequest({ config, request, url, workspace, proxyPath });
    assert.equal(response.status, 200, await response.clone().text());
    if (path === "/event") return response.text();
    const payload = await response.json();
    return v2 ? payload.data : payload;
  };
  try {
    for (const v2 of [false, true]) {
      const created = await call(v2, "POST", "/session", { title: v2 ? "v2" : "v1", location: { directory: a } }, a);
      assert.equal(sessions.get(created.id)?.directory, a, `v${v2 ? 2 : 1} must execute in project A`);
      assert.equal(created.directory, company);
      assert.equal(created.openworkHomeDirectory, company);
      assert.equal(created.executionDirectory, a);
      assert.equal(created.projectId, "proj:A");
      assert.equal((await readSessionGroupState(config, workspace.id)).state.sessionMeta[created.id]?.projectId, "proj:A", "native creation registers its project group without a frontend write");
      await updateSessionGroupState(config, workspace.id, state => ({ ...state, sessionMeta: { ...state.sessionMeta, [created.id]: { ...state.sessionMeta[created.id], agentName: "designer" } } }));
      const fork = await call(v2, "POST", `/session/${created.id}/fork`, {});
      const forkState = (await readSessionGroupState(config, workspace.id)).state;
      assert.equal(forkState.sessionMeta[fork.id]?.projectId, "proj:A");
      assert.equal(forkState.sessionMeta[fork.id]?.agentName, "designer");
      if (v2) sessions.set("ses_foreign_moved", { id: "ses_foreign_moved", directory: a, title: "foreign moved", location: { directory: a } });
      const listed = await call(v2, "GET", "/session");
      assert.ok(listed.some((session: { id: string }) => session.id === created.id));
      assert.ok(!listed.some((session: { id: string }) => session.id === "ses_foreign_moved"), "mutable CWD cannot grant company ownership");
      const restored = await call(v2, "GET", `/session/${created.id}`, undefined, b);
      assert.equal(restored.executionDirectory, a, "caller query cannot move an existing conversation");
      await call(v2, "POST", `/session/${created.id}/${v2 ? "prompt" : "prompt_async"}`, { parts: [] }, b);
      assert.equal(prompts.at(-1)?.directory, a);
      const backgroundId = `ses_background_${v2 ? "v2" : "v1"}`;
      sessions.set(backgroundId, { id: backgroundId, directory: b, title: "Native background creation", location: { directory: b } });
      const events = await call(v2, "GET", "/event");
      assert.ok(events.includes(created.id));
      assert.ok(events.includes('"projectId":"proj:A"'), "created events expose the authoritative project identity");
      assert.equal((await readSessionGroupState(config, workspace.id)).state.sessionMeta[backgroundId]?.projectId, "proj:B", "native created events register background project sessions");
      assert.ok(events.includes('"executionDirectory":' + JSON.stringify(a)));
      assert.ok(!events.includes("ses_other"));
      assert.equal((await call(v2, "GET", `/session/${created.id}`)).openworkHomeDirectory, company,
        "a late created event must never replace the company home with the project directory");
      const rejected = await call(v2, "POST", "/session", { location: { directory: root } }, root);
      assert.equal(sessions.get(rejected.id)?.directory, company, "external creation falls back to company");
    }
  } finally {
    engine.stop(true);
    if (previous.runtime === undefined) delete process.env.OPENWORK_RUNTIME_DB; else process.env.OPENWORK_RUNTIME_DB = previous.runtime;
    if (previous.database === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previous.database;
    await rm(root, { recursive: true, force: true });
  }
});
