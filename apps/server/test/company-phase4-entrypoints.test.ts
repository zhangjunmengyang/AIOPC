import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ServerConfig } from "../src/types.js";

test("company org, goals and costs are registered on the authenticated HTTP server", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-phase4-routes-")));
  const company = join(root, "company");
  await mkdir(join(company, "projects", "Alpha"), { recursive: true });
  const env = {
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
    OPENCODE_DB: join(root, "empty.sqlite"),
    OPENWORK_DATA_DIR: join(root, "data"),
    OPENWORK_ENGINE_AUTO_UPGRADE: "0",
    OPENWORK_ENGINE_V2: "0",
  };
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/session") return Response.json([]);
      return new Response(null, { status: 404 });
    },
  });
  const baseUrl = `http://127.0.0.1:${engine.port}`;
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "phase4-test", hostToken: "phase4-host",
    configPath: join(root, "server.json"), externalOpencode: true,
    opencodeBaseUrl: baseUrl, engineAutoUpgrade: false,
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "company", name: "Company", path: company, preset: "starter", workspaceType: "local", baseUrl }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "generated",
    hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  let stop: (() => Promise<void>) | undefined;
  try {
    const { startServer } = await import("../src/server.js");
    const host = await startServer(config);
    stop = () => host.stop();
    const origin = `http://127.0.0.1:${host.port}`;
    const headers = { Authorization: "Bearer phase4-test" };
    for (const path of ["company/org-chart", "goals", "company-costs"]) {
      const route = `/workspace/company/${path}`;
      const denied = await fetch(origin + route, { signal: AbortSignal.timeout(5_000) });
      assert.equal(denied.status, 401, route);
      const response = await fetch(origin + route, { headers, signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200, `${route}: ${await response.text()}`);
      const unknown = await fetch(`${origin}/workspace/missing/${path}`, { headers, signal: AbortSignal.timeout(5_000) });
      assert.equal(unknown.status, 404, path);
    }
  } finally {
    await stop?.();
    engine.stop(true);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
