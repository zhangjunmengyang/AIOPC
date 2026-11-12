import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createPortProbe } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { renderOpencodeV2Config } from "../src/managed-opencode-v2.js";

// All engines, model replies and MCP requests are isolated; no external account/model is used.
test("native v1 and v2 send trusted session metadata to a real stdio MCP", { timeout: 180_000 }, async t => {
  const binaries = [process.env.AIOPC_TEST_V1_BINARY, process.env.AIOPC_TEST_V2_BINARY];
  if (!binaries.every(Boolean)) { t.skip("set AIOPC_TEST_V1_BINARY and AIOPC_TEST_V2_BINARY to run native metadata validation"); return; }
  for (const binary of binaries) await access(binary!);
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-native-meta-")));
  let calls = 0; const requests: any[] = [];
  const model = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    const request = JSON.parse(body); requests.push(request);
    const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "metadata-test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const tool = request.tools?.find((item: any) => item.function?.name?.includes("probe"));
    if (tool && calls++ === 0) res.end(frame({ role: "assistant", tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name: tool.function.name, arguments: JSON.stringify({ sessionID: "forged-model-session" }) } }] }) + frame({}, "tool_calls") + "data: [DONE]\n\n");
    else res.end(frame({ role: "assistant", content: "Metadata checked." }) + frame({}, "stop") + "data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const address = model.address(); assert.ok(address && typeof address !== "string");
  const modelURL = `http://127.0.0.1:${address.port}/v1`;
  try {
    for (const [index, binary] of binaries.entries()) {
      const v2 = index === 1, lane = join(root, `v${index + 1}`), captured = join(lane, "captured.jsonl"), fixture = join(lane, "mcp.mjs");
      await mkdir(lane); const configDirectory = join(lane, "config"); await mkdir(configDirectory);
      await writeFile(fixture, `import readline from 'node:readline';import{appendFileSync}from'node:fs';for await(const line of readline.createInterface({input:process.stdin})){let r;try{r=JSON.parse(line)}catch{continue}if(!('id'in r))continue;let result={};if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}};else if(r.method==='tools/list')result={tools:[{name:'probe',description:'Inspect trusted metadata',inputSchema:{type:'object',properties:{sessionID:{type:'string'}},required:[]}}]};else if(r.method==='tools/call'){appendFileSync(${JSON.stringify(captured)},JSON.stringify(r.params)+'\\n');result={content:[{type:'text',text:'ok'}]}}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')}`);
      const mcp = { probe: { type: "local", command: [process.execPath, fixture], ...(v2 ? { codemode: false } : {}) } };
      const nativeConfig = v2 ? { ...renderOpencodeV2Config({ providers: [{ id: "fixture", name: "Fixture", baseUrl: modelURL, apiKey: "fixture", models: [{ id: "fixture", name: "Fixture", config: { tool_call: true } }] }], skills: [], permissions: [{ action: "*", resource: "*", effect: "allow" }] }), mcp }
        : { provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: modelURL, apiKey: "fixture" }, models: { fixture: { name: "Fixture", limit: { context: 128000, output: 4096 } } } } }, mcp, permission: "allow" };
      await writeFile(join(configDirectory, "opencode.json"), JSON.stringify(nativeConfig));
      const probe = createPortProbe(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
      const free = probe.address(); assert.ok(free && typeof free !== "string"); const port = free.port; await new Promise<void>(resolve => probe.close(() => resolve()));
      const env = { PATH: process.env.PATH, HOME: lane, XDG_CONFIG_HOME: join(lane, "xdg-config"), XDG_CACHE_HOME: join(lane, "cache"), XDG_DATA_HOME: join(lane, "data"), XDG_STATE_HOME: join(lane, "state"), OPENCODE_DB: join(lane, "engine.sqlite"), OPENCODE_CONFIG_DIR: configDirectory, OPENCODE_SERVER_PASSWORD: "fixture", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true" };
      const child = spawn(binary!, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: lane, env, stdio: "pipe" });
      let logs = ""; child.stdout.on("data", data => logs += data); child.stderr.on("data", data => logs += data);
      const base = `http://127.0.0.1:${port}`, auth = `Basic ${Buffer.from("opencode:fixture").toString("base64")}`;
      const call = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(base + (v2 ? "/api" : "") + path, { method, headers: { Authorization: auth, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45_000) });
        const value = await response.text(); assert.ok(response.ok, `${response.status}: ${value}\n${logs.slice(-3000)}`); const parsed = JSON.parse(value); return v2 ? parsed.data : parsed;
      };
      try {
        const until = Date.now() + 45_000;
        while (true) {
          const health = await fetch(base + (v2 ? "/api/info" : "/global/health"), { headers: { Authorization: auth }, signal: AbortSignal.timeout(1000) }).catch(() => null);
          if (health?.ok) break;
          if (child.exitCode !== null || Date.now() > until) throw new Error(logs);
          await delay(100);
        }
        calls = 0; requests.length = 0;
        const session = await call("POST", "/session", v2 ? { model: { providerID: "fixture", id: "fixture" } } : {});
        await call("POST", `/session/${session.id}/${v2 ? "prompt" : "message"}`, v2 ? { text: "Call the probe tool once." } : { model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: "Call the probe tool once." }] });
        let values: any[] = []; const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) { try { values = (await readFile(captured, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { /* Await native tool call. */ } if (values.length) break; await delay(100); }
        assert.equal(values.length, 1, JSON.stringify({ tools: requests.map(r => r.tools?.map((t: any) => t.function?.name)), logs: logs.slice(-4000) }));
        assert.equal(values[0]._meta["ai.opencode/sessionID"], session.id);
        assert.equal(values[0].arguments.sessionID, "forged-model-session");
        console.log(`GREEN native v${index + 1} stdio MCP: host sessionID=${session.id}; model forgery ignored`);
      } finally {
        if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(2000)]); if (child.exitCode === null) child.kill("SIGKILL"); }
      }
    }
  } finally {
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
