import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runScheduledJob, scheduledArguments, scheduledConfig } from "./scheduler-launcher.mjs";
import { configureAiopcScheduler, patchSchedulerPlugin } from "./aiopc-scheduler.mjs";

test("background tasks force their restricted agent and reject remote attachment/sharing", () => {
  assert.deepEqual(scheduledArguments(["run", "--agent", "build", "--model", "test/model", "--", "report --agent build"]),
    ["run", "--agent", "aiopc-scheduled", "--model", "test/model", "--", "report --agent build"]);
  assert.deepEqual(scheduledArguments(["--version"]), ["--version"]);
  for (const flag of ["--share", "--share=true", "--attach", "--attach=http://localhost:4096"]) {
    assert.throws(() => scheduledArguments(["run", flag]), /cannot share or attach/);
  }
  for (const flag of ["--command", "--file", "--continue", "--session"]) {
    assert.throws(() => scheduledArguments(["run", flag, "test"]), /Unsupported background-run option/);
  }
  assert.throws(() => scheduledArguments(["serve"]), /must use opencode run/);
});

test("background configuration allows reports while blocking publishing and interactive tools", () => {
  const config = scheduledConfig({ home: "/data", serviceDir: "/service", uv: "/bin/uv" });
  assert.equal(config.share, "disabled");
  assert.equal(config.permission["*"], "deny");
  assert.equal(config.permission.write, "allow");
  assert.equal(config.permission.webfetch, "allow");
  assert.equal(config.permission.question, "deny");
  assert.equal(config.permission.external_directory, "deny");
  assert.equal(config.permission.aiopc_social_publish, undefined);
  assert.deepEqual(config.agent["aiopc-scheduled"].permission, config.permission);
  assert.equal(config.mcp.aiopc.type, "local");
});

test("independent runs isolate each project database and discard desktop connection configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiopc-scheduler-test-"));
  try {
    const home = path.join(root, "home");
    const engine = path.join(root, "engine");
    const output = path.join(root, "capture.json");
    await writeFile(engine, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.TEST_SCHEDULER_OUTPUT, JSON.stringify({args:process.argv.slice(2),env:process.env,cwd:process.cwd()}));\n`, { mode: 0o700 });
    const settings = path.join(root, "settings.json");
    await writeFile(settings, JSON.stringify({ home, opencodeBin: engine, serviceDir: path.join(root, "service"), uv: "/bin/uv" }));
    const env = {
      TEST_SCHEDULER_OUTPUT: output,
      OPENCODE_DB: "/old-desktop.sqlite",
      OPENCODE_CONFIG_CONTENT: "desktop config",
      OPENWORK_SERVER_PASSWORD: "desktop-only",
      OPENCODE_SCHEDULER_RUN_ID: "scheduled-run",
    };
    const databases = [];
    for (const name of ["project-a", "project-b"]) {
      const cwd = path.join(root, name);
      await mkdir(cwd);
      assert.equal(await runScheduledJob(settings, ["run", "--", "write report"], { cwd, env }), 0);
      const actual = JSON.parse(await readFile(output, "utf8"));
      assert.equal(actual.env.OPENWORK_SERVER_PASSWORD, undefined);
      assert.equal(actual.env.OPENCODE_CONFIG_CONTENT, undefined);
      assert.equal(actual.env.OPENCODE_SCHEDULER_RUN_ID, "scheduled-run");
      assert.equal(actual.env.AIOPC_HOME, home);
      assert.equal(actual.env.OPENCODE_DISABLE_SHARE, "true");
      assert.ok(actual.env.OPENCODE_DB.startsWith(path.join(home, "scheduler", "workspaces")));
      databases.push(actual.env.OPENCODE_DB);
      const config = JSON.parse(await readFile(actual.env.OPENCODE_CONFIG, "utf8"));
      assert.equal(config.default_agent, "aiopc-scheduled");
      assert.deepEqual(actual.args, ["run", "--agent", "aiopc-scheduled", "--", "write report"]);
    }
    assert.notEqual(databases[0], databases[1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upstream changes cannot silently remove the verified supervisor compatibility fix", () => {
  assert.throws(() => patchSchedulerPlugin("changed supervisor"), /review the pinned compatibility patch/);
});

test("installed ESM scheduler resolves without a development override", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiopc-scheduler-install-"));
  try {
    await mkdir(path.join(root, "resources", "sidecars"), { recursive: true });
    await writeFile(path.join(root, "resources", "sidecars", "opencode"), "");
    const env = {};
    const home = path.join(root, "home");
    const result = configureAiopcScheduler({ app: { isPackaged: false }, desktopRoot: root, serviceDir: "/service", uv: "/uv", home, env });
    assert.equal(result.launcher, path.join(home, "bin", "aiopc-scheduled"));
    assert.equal(env.AIOPC_SCHEDULER_ENTRY, path.join(home, "scheduler", "scheduler-mcp.mjs"));
    assert.ok(env.AIOPC_SCHEDULER_SDK);
    const plugin = await readFile(path.join(home, "scheduler", "plugin.mjs"), "utf8");
    assert.ok(!plugin.includes("local $SIG{ALRM} = sub {"));
    assert.ok(plugin.includes('var SUPERVISOR_PATH = join(dirname(fileURLToPath(import.meta.url)), "supervisor.pl");'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
