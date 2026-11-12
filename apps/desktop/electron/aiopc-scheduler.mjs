import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

function quoteShell(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/** Keep the alarm handler alive through waitpid in the pinned 1.3.0 supervisor. */
export function patchSchedulerPlugin(source) {
  const alarm = "local $SIG{ALRM} = sub {";
  const marker = '$job->{lastRunSource} = "scheduled";';
  const supervisor = 'var SUPERVISOR_PATH = join(SCHEDULER_DIR, "supervisor.pl");';
  if (!source.includes(alarm) || !source.includes(marker) || !source.includes(supervisor)) throw new Error("Unsupported opencode-scheduler supervisor; review the pinned compatibility patch.");
  return source.replace(alarm, "$SIG{ALRM} = sub {")
    .replace(marker, '$job->{lastRunSource} = $ENV{AIOPC_SCHEDULER_RUN_SOURCE} || "scheduled";')
    // Another project's unpatched plugin must not overwrite our supervisor.
    .replace(supervisor, 'var SUPERVISOR_PATH = join(dirname(fileURLToPath(import.meta.url)), "supervisor.pl");');
}

/** A stable entrypoint for OS-scheduled jobs, independent of the desktop server. */
export function configureAiopcScheduler({ app, desktopRoot, serviceDir, uv, home, env = process.env, nodePath = process.execPath }) {
  // The Unix supervisor provides timeout and overlap protection. The upstream
  // Windows scheduler bypasses it, so do not expose an unreliable equivalent.
  if (process.platform === "win32") return null;
  const opencodeBin = app.isPackaged
    ? path.join(process.resourcesPath, "sidecars", "opencode")
    : path.join(desktopRoot, "resources", "sidecars", "opencode");
  if (!existsSync(opencodeBin)) return null;
  const root = path.join(home, "scheduler");
  const bin = path.join(home, "bin");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const runner = path.join(root, "scheduler-launcher.mjs");
  copyFileSync(path.join(sourceDir, "scheduler-launcher.mjs"), runner);
  writeFileSync(path.join(root, "settings.json"), `${JSON.stringify({ home, serviceDir, uv, opencodeBin, library: env.AIOPC_LIBRARY || undefined }, null, 2)}\n`, { mode: 0o600 });
  const launcher = path.join(bin, "aiopc-scheduled");
  writeFileSync(launcher, `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quoteShell(nodePath)} ${quoteShell(runner)} "$@"\n`, { mode: 0o700 });
  chmodSync(launcher, 0o700);
  env.OPENCODE_SCHEDULER_OPENCODE_PATH = launcher;
  const require = createRequire(import.meta.url);
  const pluginPath = env.AIOPC_SCHEDULER_PLUGIN || (() => { try { return fileURLToPath(import.meta.resolve("opencode-scheduler")); } catch { return null; } })();
  if (pluginPath) {
    writeFileSync(path.join(root, "plugin.mjs"), patchSchedulerPlugin(readFileSync(pluginPath, "utf8")), { mode: 0o600 });
    const entry = path.join(root, "scheduler-mcp.mjs");
    copyFileSync(path.join(sourceDir, "scheduler-mcp.mjs"), entry);
    const sdkRoot = path.resolve(path.dirname(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")), "../../..");
    env.AIOPC_SCHEDULER_NODE = nodePath;
    env.AIOPC_SCHEDULER_ENTRY = entry;
    env.AIOPC_SCHEDULER_SDK = sdkRoot;
  }
  return { launcher, settingsPath: path.join(root, "settings.json") };
}
