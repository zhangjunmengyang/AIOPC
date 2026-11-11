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
  assert.deepEqual(servers.aiopc.command, ["/bin/uv", "run", "--project", "/svc", "--frozen", "--no-dev", "--quiet", "python", "-m", "aiopc.server", "--stdio"]);
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
