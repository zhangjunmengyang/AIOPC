import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createAiopcLeaseLifecycle, type LeaseRelease } from "../src/aiopc-lease-lifecycle.js";
import { renderOpencodeV2Config } from "../src/managed-opencode-v2.js";
import type { ServerConfig, WorkspaceInfo } from "../src/types.js";
import { ensureWorkspaceFiles } from "../src/workspace-init.js";
import { readSessionGroupState, updateSessionGroupState } from "../src/session-groups.js";

// Run in an isolated process. Only temporary files and metadata APIs are used;
// A loopback model stub inspects native prompts; no external model, account,
// publication or installed user's engine is touched.
test("real v1 and v2 preserve project CWD, company home and project skill discovery", { timeout: 120_000 }, async t => {
  const binaries = [process.env.OPENWORK_TEST_OPENCODE ?? "/Applications/AIOPC.app/Contents/Resources/sidecars/opencode",
    process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/AIOPC.app/Contents/Resources/sidecars/opencode2"];
  for (const binary of binaries) {
    try { await access(binary); } catch { t.skip("requires the two installed OpenCode sidecars"); return; }
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-company-native-")));
  const modelRequests: unknown[] = [];
  const model = createHttpServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += String(chunk);
    const request = JSON.parse(text);
    modelRequests.push(request);
    const serialized = JSON.stringify(request.messages);
    const callRoleTool = serialized.includes("TEST_ROLE_TOOL")
      && request.tools?.some((tool: { function?: { name?: string } }) => tool.function?.name === "skill")
      && !request.messages.some((message: { role: string }) => message.role === "tool");
    const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "company-scope", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (callRoleTool) {
      const id = serialized.includes("TEST_ROLE_TOOL_ALLOWED") ? "brand-naming" : "company-common";
      res.end(frame({ role: "assistant", tool_calls: [{ index: 0, id: "fixture_role_skill", type: "function", function: {
        name: "skill", arguments: JSON.stringify({ id }),
      } }] }) + frame({}, "tool_calls") + "data: [DONE]\n\n");
      return;
    }
    res.end(frame({ role: "assistant", content: "Local company scope verified" }) + frame({}, "stop") + "data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const modelAddress = model.address(); assert.ok(modelAddress && typeof modelAddress !== "string");
  const original = new Map<string, string | undefined>();
  const set = (key: string, value: string) => { if (!original.has(key)) original.set(key, process.env[key]); process.env[key] = value; };
  set("OPENWORK_RUNTIME_DB", join(root, "runtime.sqlite"));
  set("OPENCODE_DB", join(root, "host-history.sqlite"));
  const { proxyOpencodeRequest, proxyOpencodeV2Request } = await import("../src/server.js");
  try {
    for (const [index, binary] of binaries.entries()) {
      const v2 = index === 1;
      modelRequests.length = 0;
      const lane = join(root, v2 ? "v2" : "v1");
      const company = join(lane, "outer", "company");
      const projects = [join(company, "projects", "A"), join(company, "projects", "B")];
      await mkdir(projects[0], { recursive: true }); await mkdir(projects[1]);
      await ensureWorkspaceFiles(company, "starter");
      for (const [folder, name] of [[lane, "global-user"], [join(lane, "outer"), "outside-company"], [company, "company-common"], [projects[0], "project-a"], [projects[1], "project-b"]]) {
        const skill = join(folder!, ".opencode", "skills", name!);
        await mkdir(skill, { recursive: true });
        await writeFile(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: isolated test skill\n---\nLocal test.\n`);
      }
      await mkdir(join(company, ".opencode", "agent"), { recursive: true });
      await writeFile(join(company, ".opencode", "agent", "designer.md"), "---\ndescription: Company designer\nmode: primary\n---\nDesign for the current project.\n");
      const probe = createServer();
      await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
      const address = probe.address(); assert.ok(address && typeof address !== "string");
      const port = address.port;
      await new Promise<void>(resolve => probe.close(() => resolve()));
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: lane, XDG_CONFIG_HOME: join(lane, "config"),
        XDG_CACHE_HOME: join(lane, "cache"), XDG_DATA_HOME: join(lane, "data"), XDG_STATE_HOME: join(lane, "state"),
        OPENCODE_DB: join(lane, "engine.sqlite"), OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_SERVER_PASSWORD: "native-test",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true" };
      if (!v2) {
        const nativeConfigDirectory = join(lane, "native-config"); await mkdir(nativeConfigDirectory, { recursive: true });
        await writeFile(join(nativeConfigDirectory, "opencode.json"), JSON.stringify({ provider: { native_fixture: {
          npm: "@ai-sdk/openai-compatible", name: "Local fixture", options: { baseURL: `http://127.0.0.1:${modelAddress.port}/v1`, apiKey: "fixture" },
          models: { fixture: { name: "Fixture", limit: { context: 128000, output: 4096 } } },
        } } }));
        env.OPENCODE_CONFIG_DIR = nativeConfigDirectory;
      }
      if (v2) {
        const trustedSkills = join(lane, "trusted-skills");
        await mkdir(join(trustedSkills, "trusted-bundle"), { recursive: true });
        await writeFile(join(trustedSkills, "trusted-bundle", "SKILL.md"), "---\nname: trusted-bundle\ndescription: explicitly trusted skills\n---\nLocal trusted bundle.\n");
        const pluginDirectory = join(lane, "company-skills-plugin");
        await mkdir(pluginDirectory, { recursive: true });
        await writeFile(join(pluginDirectory, "package.json"), JSON.stringify({ type: "module" }));
        await writeFile(join(pluginDirectory, "server.js"), `export { default } from ${JSON.stringify(new URL("../src/opencode-plugins/openwork-company-skills-v2.ts", import.meta.url).href)};\n`);
        const nativeConfigDirectory = join(lane, "native-config");
        await mkdir(nativeConfigDirectory);
        const nativeConfig = join(nativeConfigDirectory, "opencode.json");
        await writeFile(nativeConfig, JSON.stringify(renderOpencodeV2Config({ providers: [{ id: "native_fixture", name: "Local fixture", apiKey: "fixture", baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`, models: [{ id: "fixture", name: "Fixture", config: { limit: { context: 128000, output: 4096 }, tool_call: true } }] }], skills: [trustedSkills], companySkillsPluginDirectory: pluginDirectory })));
        env.OPENCODE_CONFIG_DIR = nativeConfigDirectory;
      }
      let logs = "";
      const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: company, env, stdio: "pipe" });
      child.stdout.on("data", data => { logs += data.toString(); }); child.stderr.on("data", data => { logs += data.toString(); });
      const baseUrl = `http://127.0.0.1:${port}`;
      const auth = `Basic ${Buffer.from("opencode:native-test").toString("base64")}`;
      const workspace: WorkspaceInfo = { id: `native-${index}`, name: "company", path: company, preset: "starter", workspaceType: "local", baseUrl,
        opencodeUsername: "opencode", opencodePassword: "native-test" };
      const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "test", configPath: join(lane, "server.json"),
        approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [root], readOnly: false,
        startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false };
      let leaseWatch: ReturnType<typeof createAiopcLeaseLifecycle> | undefined;
      const releases: LeaseRelease[] = [];
      try {
        const deadline = Date.now() + 45_000;
        while (true) {
          const health = await fetch(baseUrl + (v2 ? "/api/info" : "/global/health"), { headers: { Authorization: auth }, signal: AbortSignal.timeout(1000) }).catch(() => null);
          if (health?.ok) break;
          if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`engine failed: ${logs.slice(-4000)}`);
          await delay(200);
        }
        let watching = false;
        leaseWatch = createAiopcLeaseLifecycle({ targets: () => [{ key: v2 ? "v2" : "v1", url: baseUrl + (v2 ? "/api/event" : "/global/event"), headers: { Authorization: auth } }],
          fetchImpl: Object.assign(async (...args: Parameters<typeof fetch>) => { const response = await fetch(...args); watching = response.ok; return response; }, { preconnect: fetch.preconnect }),
          release: async value => { releases.push(value); }, pollMs: 100,
        });
        const watchingDeadline = Date.now() + 5_000;
        while (!watching && Date.now() < watchingDeadline) await delay(25);
        assert.ok(watching, `native v${index + 1} lifecycle stream did not connect`);
        const call = async (method: string, path: string, body?: unknown, directory = company) => {
          const proxyPath = `${v2 ? "/opencode2/api" : "/opencode"}${path}`;
          const url = new URL(`http://host${proxyPath}`);
          url.searchParams.set(v2 ? "location[directory]" : "directory", directory);
          const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
          const response = v2 ? await proxyOpencodeV2Request({ actor: { type: "host" }, config, request, url, workspace, proxyPath,
            connection: { url: baseUrl, username: "opencode", password: "native-test" } })
            : await proxyOpencodeRequest({ config, request, url, workspace, proxyPath });
          if (method === "DELETE" && response.status === 204) return null;
          assert.equal(response.status, 200, await response.clone().text());
          const result = await response.json(); return v2 ? result.data : result;
        };
        const ids: string[] = [];
        for (const directory of projects) {
          const created = await call("POST", "/session", { title: "公司项目验收", ...(v2 ? { location: { directory }, model: { providerID: "native_fixture", id: "fixture" } } : {}) }, directory);
          ids.push(created.id);
          assert.equal(created.directory, company); assert.equal(created.executionDirectory, directory);
          const restored = await call("GET", `/session/${created.id}`);
          assert.equal(restored.executionDirectory, directory);
        }
        const listed = await call("GET", "/session");
        assert.deepEqual(listed.map((session: { id: string }) => session.id).sort(), [...ids].sort());
        if (!v2) {
          await call("POST", `/session/${ids[0]}/message`, { model: { providerID: "native_fixture", modelID: "fixture" }, parts: [{ type: "text", text: "Reply with a short acknowledgement. Do not use tools." }] });
          const idleDeadline = Date.now() + 5_000;
          while (!releases.some(item => item.sessionId === ids[0] && item.reason === "turn_end") && Date.now() < idleDeadline) await delay(25);
          assert.ok(releases.some(item => item.sessionId === ids[0] && item.reason === "turn_end"), "native v1 completion must release without renderer");
          assert.ok(modelRequests.length, "v1 used the loopback model fixture");
        }
        if (v2) {
          await call("POST", `/session/${ids[0]}/prompt`, { text: "State the available project skills. Do not use tools." });
          const modelDeadline = Date.now() + 10_000;
          while (!modelRequests.length && Date.now() < modelDeadline) await delay(50);
          assert.ok(modelRequests.length, `native model was not reached: ${logs}`);
          const idleDeadline = Date.now() + 5_000;
          while (!releases.some(item => item.sessionId === ids[0] && item.reason === "turn_end") && Date.now() < idleDeadline) await delay(25);
          assert.ok(releases.some(item => item.sessionId === ids[0] && item.reason === "turn_end"), "native v2 completion must release without renderer");
          const visible = JSON.stringify(modelRequests[0]);
          assert.ok(visible.includes("project-a"), visible.slice(-5000));
          assert.ok(visible.includes("company-common"), visible.slice(-5000));
          assert.ok(visible.includes("global-user"), "global user skill was lost");
          assert.ok(visible.includes("trusted-bundle"), "trusted bundle skill was lost");
          assert.ok(!visible.includes("outside-company"), "outside skill reached the model");
          assert.ok(!visible.includes("project-b"), "sibling skill reached the model");
          for (const name of ["outside-company", "project-b"]) {
            const rejected = await fetch(`${baseUrl}/api/session/${ids[0]}/prompt`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
              body: JSON.stringify({ text: "Use this skill", skills: [{ id: name, name }] }) });
            const error = await rejected.text();
            assert.ok(rejected.status >= 400, `explicit forbidden skill was admitted: ${name}: ${error}`);
            assert.ok(error.includes(`Skill not found: ${name}`), error);
          }
        }
        if (v2) {
          await writeFile(join(projects[0], ".opencode", "skills-lock.json"), JSON.stringify({ version: 1, skills: {
            "project-a": { id: "audited-project-a", hash: "a".repeat(64) },
          } }));
          const roleChat = async () => {
            const created = await call("POST", "/session", { title: "品牌设计师验收", location: { directory: projects[0] }, model: { providerID: "native_fixture", id: "fixture" } }, projects[0]);
            await updateSessionGroupState(config, workspace.id, state => ({ ...state, sessionMeta: { ...state.sessionMeta, [created.id]: { ...state.sessionMeta[created.id], agentName: "brand-designer" } } }));
            return created.id as string;
          };
          const roleId = await roleChat();
          const roleTurn = async (id: string, text: string, body = {}) => {
            const before = modelRequests.length;
            await call("POST", `/session/${id}/prompt`, { text, ...body });
            const deadline = Date.now() + 10_000;
            while (!releases.some(item => item.sessionId === id && item.reason === "turn_end") && Date.now() < deadline) await delay(50);
            assert.ok(releases.some(item => item.sessionId === id && item.reason === "turn_end"), logs.slice(-5000));
            return modelRequests.slice(before).map(item => JSON.stringify((item as { messages: unknown }).messages));
          };
          const [visible] = await roleTurn(roleId, "列出当前角色可以使用的技能。", { skills: [{ id: "project-a" }] });
          assert.ok(visible?.includes("brand-naming"), visible?.slice(-7000));
          assert.ok(visible?.includes("project-a"), visible?.slice(-7000));
          for (const hidden of ["company-common", "trusted-bundle", "global-user", "project-b"]) {
            assert.ok(!visible?.includes(hidden), `unexpected role skill: ${hidden}`);
          }
          const denied = await roleTurn(await roleChat(), "TEST_ROLE_TOOL_DENIED");
          assert.ok(denied.some(request => /permission denied|denied permission|BlockedError|Unable to load skill company-common/i.test(request)), denied.at(-1)?.slice(-4500));
          const allowed = await roleTurn(await roleChat(), "TEST_ROLE_TOOL_ALLOWED");
          assert.ok(allowed.some(request => request.includes("为不同语义方向各拟候选")), allowed.at(-1)?.slice(-6000));
          for (const endpoint of ["prompt", "skill"]) {
            const path = endpoint === "skill" ? `/opencode2/api/experimental/session/${roleId}/skill` : `/opencode2/api/session/${roleId}/prompt`;
            const url = new URL(`http://host${path}`);
            const request = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify(endpoint === "skill" ? { id: "company-common", resume: false } : { text: "附带越权技能", skills: [{ id: "company-common" }] }) });
            await assert.rejects(() => proxyOpencodeV2Request({ actor: { type: "host" }, config, request, url, workspace, proxyPath: path,
              connection: { url: baseUrl, username: "opencode", password: "native-test" } }), /company-common/);
          }
          console.log("GREEN native v2 role: resident + adopted catalog, skill tool allow/deny, explicit attachments + activation denied");
        }
        await updateSessionGroupState(config, workspace.id, state => ({ ...state, sessionMeta: { ...state.sessionMeta, [ids[0]!]: { ...state.sessionMeta[ids[0]!], agentName: "designer" } } }));
        const forked = await call("POST", `/session/${ids[0]}/fork`, {});
        assert.equal(forked.directory, company); assert.equal(forked.executionDirectory, projects[0]);
        const groupState = (await readSessionGroupState(config, workspace.id)).state;
        assert.equal(groupState.sessionMeta[forked.id]?.projectId, "proj:A");
        assert.equal(groupState.sessionMeta[forked.id]?.agentName, "designer");
        await call("DELETE", `/session/${forked.id}`);
        const deletedDeadline = Date.now() + 5_000;
        while (!releases.some(item => item.sessionId === forked.id && item.reason === "deleted") && Date.now() < deletedDeadline) await delay(25);
        assert.ok(releases.some(item => item.sessionId === forked.id && item.reason === "deleted"), `native v${index + 1} deletion must release without renderer`);
        let skills: Array<{ name: string }> = [];
        const skillDeadline = Date.now() + 5000;
        do {
          skills = await call("GET", "/skill", undefined, projects[0]);
          if (skills.some(skill => skill.name === "project-a")) break;
          await delay(100);
        } while (Date.now() < skillDeadline);
        const names = skills.map((skill: { name: string }) => skill.name);
        assert.ok(names.includes("project-a"), JSON.stringify(names));
        assert.ok(names.includes("company-common"), JSON.stringify(names));
        assert.ok(!names.includes("project-b"), JSON.stringify(names));
        assert.ok(!names.includes("outside-company"), JSON.stringify({ names, logs: logs.slice(-4000) }));
        const agents = await call("GET", "/agent", undefined, projects[0]);
        assert.ok(agents.some((agent: { name?: string; id?: string }) => agent.name === "designer" || agent.id === "designer"), JSON.stringify(agents));
        console.log(`GREEN native v${index + 1}: two project CWDs, company home/list/restore, fork project group + role, project + company skills, no sibling skills`);
      } finally {
        await leaseWatch?.stop();
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(2000)]);
          if (child.exitCode === null) child.kill("SIGKILL");
        }
      }
    }
  } finally {
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
