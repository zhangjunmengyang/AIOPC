import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aiopcMcpServers, aiopcSkillDirectories, withAiopcInstructions } from "../src/aiopc-runtime.js";

test("AIOPC adds nothing until the desktop app names its service", () => {
  assert.deepEqual(aiopcMcpServers({}), {});
  assert.deepEqual(aiopcSkillDirectories({ AIOPC_SERVICE_DIR: "/svc" }), []);
  assert.equal(withAiopcInstructions("base", {}), "base");
});

test("AIOPC's MCP runs the service over stdio with only its own settings", () => {
  const servers = aiopcMcpServers({ AIOPC_SERVICE_DIR: "/svc", AIOPC_UV: "/bin/uv", AIOPC_HOME: "/home/.aiopc", SECRET: "x" });
  assert.deepEqual(servers.aiopc.command, ["/bin/uv", "run", "--project", "/svc", "--frozen", "--no-dev", "--quiet", "python", "-I", "-B", "-m", "aiopc.server", "--stdio"]);
  assert.deepEqual(servers.aiopc.environment, { AIOPC_HOME: "/home/.aiopc" });
  assert.deepEqual(aiopcSkillDirectories({ AIOPC_SERVICE_DIR: "/svc", AIOPC_UV: "/bin/uv" }), ["/svc/skills"]);
});

test("AIOPC's instructions follow the base prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aiopc-runtime-"));
  try {
    await writeFile(join(dir, "instructions.md"), "# AIOPC 工作方式\n");
    assert.equal(withAiopcInstructions("base", { AIOPC_SERVICE_DIR: dir, AIOPC_UV: "/bin/uv" }), "base\n\n# AIOPC 工作方式");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AIOPC configures the same local scheduler MCP for either engine without forwarding secrets", () => {
  const schedulerEnv = {
    AIOPC_SCHEDULER_NODE: "/Applications/AIOPC.app/Contents/MacOS/AIOPC",
    AIOPC_SCHEDULER_ENTRY: "/home/.aiopc/scheduler/scheduler-mcp.mjs",
    OPENCODE_SCHEDULER_OPENCODE_PATH: "/home/.aiopc/scheduler/launcher",
    AIOPC_SCHEDULER_SDK: "/app/node_modules/@modelcontextprotocol/sdk",
    AIOPC_HOME: "/home/.aiopc",
  };
  const servers = aiopcMcpServers({ ...schedulerEnv, SECRET: "never-forwarded" });
  assert.deepEqual(servers.scheduler, {
    type: "local", enabled: true,
    command: [schedulerEnv.AIOPC_SCHEDULER_NODE, schedulerEnv.AIOPC_SCHEDULER_ENTRY],
    environment: { ...schedulerEnv, ELECTRON_RUN_AS_NODE: "1" },
  });
  assert.deepEqual(aiopcMcpServers({ ...schedulerEnv, AIOPC_SCHEDULER_SDK: "" }), {});
});

test("MCP receives only the scoped runtime discovery path", () => {
  const servers = aiopcMcpServers({ AIOPC_SERVICE_DIR: "/svc", AIOPC_UV: "/bin/uv",
    AIOPC_RUNTIME_CONTEXT_FILE: "/private/runtime.json", OPENWORK_HOST_TOKEN: "never-in-MCP-config" });
  assert.deepEqual(servers.aiopc.environment, { AIOPC_RUNTIME_CONTEXT_FILE: "/private/runtime.json" });
});
