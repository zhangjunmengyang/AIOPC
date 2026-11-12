import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { CompanyCostReport } from "@openwork/types/company-costs";
import type { ServerConfig } from "../src/types.js";

test("company cost endpoint reconciles native OpenCode v1 messages from a temporary company", { timeout: 90_000 }, async t => {
  const binary = process.env.OPENWORK_TEST_OPENCODE ?? "/Applications/AIOPC.app/Contents/Resources/sidecars/opencode";
  try { await access(binary); } catch { t.skip("requires an OpenCode v1 sidecar"); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-native-company-cost-")));
  const company = join(root, "company");
  const project = join(company, "projects", "Alpha");
  const engineConfig = join(root, "config");
  const nativeEnv = {
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"), OPENCODE_DB: join(root, "engine.sqlite"),
    OPENWORK_DATA_DIR: join(root, "openwork"), OPENWORK_ENGINE_AUTO_UPGRADE: "0", OPENWORK_ENGINE_V2: "0",
  };
  const previous = new Map(Object.keys(nativeEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, nativeEnv);
  await mkdir(project, { recursive: true });
  await mkdir(join(company, "projects", "Beta"));
  await mkdir(engineConfig);
  const model = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 });
      await request.json();
      const chunk = (value: object) => `data: ${JSON.stringify({ id: "cost-fixture", object: "chat.completion.chunk", model: "fixture", ...value })}\n\n`;
      const content = chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Local usage fixture." }, finish_reason: null }] });
      const usage = chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } });
      return new Response(content + usage + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const engineUrl = `http://127.0.0.1:${address.port}`;
  await writeFile(join(engineConfig, "opencode.json"), JSON.stringify({
    provider: { native_fixture: {
      npm: "@ai-sdk/openai-compatible", name: "Local fixture",
      options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture" },
      models: { fixture: { name: "Fixture", cost: { input: 2, output: 4 }, limit: { context: 128000, output: 4096 } } },
    } },
  }));
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(address.port)], {
    cwd: company, stdio: "pipe",
    env: {
      PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: engineConfig, XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), OPENCODE_CONFIG_DIR: engineConfig,
      OPENCODE_DB: nativeEnv.OPENCODE_DB, OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_SERVER_PASSWORD: "native-test",
    },
  });
  let logs = "";
  child.stdout.on("data", value => { logs += value.toString(); });
  child.stderr.on("data", value => { logs += value.toString(); });
  let stop: (() => Promise<void>) | undefined;
  try {
    const auth = `Basic ${Buffer.from("opencode:native-test").toString("base64")}`;
    const deadline = Date.now() + 30_000;
    while (true) {
      const health = await fetch(engineUrl + "/global/health", { headers: { authorization: auth }, signal: AbortSignal.timeout(1000) }).catch(() => null);
      if (health?.ok) break;
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`OpenCode v1 did not start: ${logs.slice(-3000)}`);
      await delay(100);
    }
    const config: ServerConfig = {
      host: "127.0.0.1", port: 0, token: "cost-test", hostToken: "cost-test-host",
      configPath: join(root, "openwork-server.json"), externalOpencode: true, engineAutoUpgrade: false, opencodeBaseUrl: engineUrl,
      workspaces: [{ id: "company", name: "Company", path: company, preset: "starter", workspaceType: "local", baseUrl: engineUrl,
        opencodeUsername: "opencode", opencodePassword: "native-test" }],
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], authorizedRoots: [root], readOnly: false,
      startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    };
    const { startServer } = await import("../src/server.js");
    const host = await startServer(config);
    stop = () => host.stop();
    const url = `http://127.0.0.1:${host.port}/workspace/company`;
    const call = async (path: string, method = "GET", body?: object) => {
      const response = await fetch(url + path, { method, body: body ? JSON.stringify(body) : undefined,
        headers: { authorization: "Bearer cost-test", "content-type": "application/json" }, signal: AbortSignal.timeout(25_000) });
      const value = await response.text();
      assert.equal(response.status, 200, value);
      return JSON.parse(value);
    };
    const alpha = await call(`/opencode/session?directory=${encodeURIComponent(project)}`, "POST", { title: "Cost in Alpha" });
    await call(`/opencode/session?directory=${encodeURIComponent(join(company, "projects", "Beta"))}`, "POST", { title: "Zero in Beta" });
    await call(`/session-groups/meta/${alpha.id}`, "PATCH", { agentName: "designer" });
    await call(`/opencode/session/${alpha.id}/message`, "POST", {
      model: { providerID: "native_fixture", modelID: "fixture" },
      parts: [{ type: "text", text: "Reply with a short acknowledgement. Do not use tools." }],
    });
    const messages = await call(`/opencode/session/${alpha.id}/message`);
    const assistant = messages.find((row: { info: { role: string } }) => row.info.role === "assistant").info;
    assert.equal(assistant.cost, 0.00036);
    assert.equal(assistant.tokens.input, 120);
    assert.equal(assistant.tokens.output, 30);
    const nativeSession = await call(`/opencode/session/${alpha.id}`);
    assert.equal(nativeSession.cost, assistant.cost);
    assert.equal(nativeSession.tokens.input, assistant.tokens.input);
    assert.equal(nativeSession.tokens.output, assistant.tokens.output);

    const report: CompanyCostReport = await call("/company-costs");
    assert.deepEqual(report.sources, { v1: "ready", v2: "disabled" });
    assert.equal(report.unreadableSessions, 0);
    assert.equal(report.totals.cost, assistant.cost);
    assert.equal(report.totals.input, assistant.tokens.input);
    assert.equal(report.totals.output, assistant.tokens.output);
    assert.deepEqual(report.byProject.map(row => [row.id, row.usage.cost]), [["proj:Alpha", assistant.cost], ["proj:Beta", 0]]);
    assert.equal(report.byRole.find(row => row.id === "designer")?.usage.cost, assistant.cost);
    assert.equal(report.bySession.find(row => row.id === alpha.id)?.usage.cost, assistant.cost);
    console.log(`v1 native + company costs: input=${report.totals.input}, output=${report.totals.output}, USD=${report.totals.cost}, sessions=${report.bySession.length}`);
  } finally {
    await stop?.();
    model.stop(true);
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
