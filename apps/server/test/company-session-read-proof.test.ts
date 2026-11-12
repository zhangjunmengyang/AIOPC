import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ServerConfig } from "../src/types.js";

test("HTTP ownership proof reads actual v1 history for an existing project session without a local origin", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-company-read-")));
  const company = join(root, "company"), project = join(company, "projects", "A");
  await mkdir(project, { recursive: true });
  const values = { OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"), OPENCODE_DB: join(root, "missing.sqlite"),
    OPENWORK_DATA_DIR: join(root, "data"), OPENWORK_ENGINE_AUTO_UPGRADE: "0", OPENWORK_ENGINE_V2: "0" };
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  let historyReads = 0;
  const session = { id: "ses_existing_project_read", directory: project, title: "Existing project", time: { created: 1, updated: 1 } };
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === `/session/${session.id}`) return Response.json(session);
    if (path === `/session/${session.id}/message`) { historyReads++; return Response.json([]); }
    if (path === "/session/status") return Response.json({});
    if (path === "/session" || path === "/question" || path === "/permission") return Response.json([]);
    return new Response(null, { status: 404 });
  } });
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"),
    externalOpencode: true, opencodeBaseUrl: `http://127.0.0.1:${engine.port}`, engineAutoUpgrade: false,
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "company", name: "company", path: company, preset: "starter", workspaceType: "local", baseUrl: `http://127.0.0.1:${engine.port}` }],
    authorizedRoots: [root], readOnly: true, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false };
  const { startServer } = await import("../src/server.js");
  const host = await startServer(config);
  try {
    const response = await fetch(`http://127.0.0.1:${host.port}/workspace/company/opencode/session/${session.id}`, {
      headers: { Authorization: "Bearer test" }, signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.executionDirectory, project);
    assert.ok(historyReads > 0, "history origin must use messages rather than metadata");
  } finally {
    await host.stop(); engine.stop(true);
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
