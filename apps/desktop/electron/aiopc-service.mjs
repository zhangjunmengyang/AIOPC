import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { configureAiopcQmd } from "./aiopc-qmd.mjs";
import { configureAiopcScheduler } from "./aiopc-scheduler.mjs";

const PREFERRED_PORT = 18800;
const HEALTH_TIMEOUT_MS = 180_000;
const MAX_RESTARTS = 5;

export function aiopcServerArgs(serviceDir, port) {
  return ["run", "--project", serviceDir, "--frozen", "--no-dev", "--quiet", "python", "-I", "-m", "aiopc.server", "--port", String(port)];
}

/** Only the desktop's workspace store supplies roots; callers cannot grant access. */
export async function writeAuthorizedCompanies(file, roots) {
  const canonical = new Set();
  for (const root of roots) {
    if (typeof root !== "string" || !path.isAbsolute(root)) continue;
    const resolved = await realpath(root).catch(() => null);
    if (resolved && (await stat(resolved).catch(() => null))?.isDirectory()) canonical.add(resolved);
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, roots: [...canonical].sort() }), { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** Host-only connection discovery; runtime children inherit the path, never the token. */
export async function writeAiopcHttpConnection(file, connection) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(connection), { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** uv from the user's PATH or its usual install places (an app opened from Finder has a minimal PATH). */
export function resolveUv({ env = process.env, exists = existsSync, home = os.homedir() } = {}) {
  const name = process.platform === "win32" ? "uv.exe" : "uv";
  const fromPath = String(env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name));
  const usual = [
    path.join(home, ".local", "bin", name),
    path.join(home, ".cargo", "bin", name),
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
  ];
  return [env.AIOPC_UV?.trim(), ...fromPath, ...usual].find((candidate) => candidate && exists(candidate)) ?? null;
}

/** The services/opc project: bundled with the app, or the repository checkout in development. */
export function resolveServiceDir({ app, desktopRoot, exists = existsSync }) {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "aiopc-service")]
    : [path.resolve(desktopRoot, "..", "..", "services", "opc")];
  return candidates.find((candidate) => exists(path.join(candidate, "pyproject.toml"))) ?? null;
}

function freePort(preferred) {
  const attempt = (port) => new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => {
      const { port: bound } = /** @type {import("node:net").AddressInfo} */ (server.address());
      server.close(() => resolve(bound));
    });
  });
  return attempt(preferred).then((port) => port ?? attempt(0));
}

/**
 * AIOPC's OPC service (services/opc). The agent runtime starts its MCP per
 * workspace over stdio; this keeps the HTTP API behind the app's own pages
 * (Space, Accounts) running for as long as the app is.
 */
export function createAiopcService({ app, desktopRoot, workspaceStore, log = console }) {
  const home = process.env.AIOPC_HOME?.trim() || path.join(os.homedir(), ".aiopc");
  const serviceDir = resolveServiceDir({ app, desktopRoot });
  const uv = resolveUv();
  const token = randomBytes(24).toString("base64url");
  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  let url = "";
  /** @type {"stopped" | "starting" | "ready" | "failed" | "unavailable"} */
  let status = serviceDir && uv ? "stopped" : "unavailable";
  let error = !serviceDir ? "找不到 AIOPC 业务服务（services/opc）" : !uv ? "没有找到 uv，请先安装：https://docs.astral.sh/uv/" : "";
  let restarts = 0;
  let stopping = false;
  const authorizedCompaniesFile = path.join(app.getPath("userData"), "aiopc-authorized-companies.json");
  const httpConnectionFile = path.join(app.getPath("userData"), "aiopc-http.json");
  let authorizationWrites = Promise.resolve();
  let authorizationRevision = 0;

  async function syncAuthorizedRoots(roots) {
    const revision = ++authorizationRevision;
    // Reading old workspace state may normalize it and publish a newer snapshot.
    // Read outside the write queue, then discard a superseded snapshot.
    const values = roots ?? await workspaceStore?.listLocalWorkspacePaths() ?? [];
    const update = authorizationWrites.catch(() => {}).then(async () => {
      if (revision === authorizationRevision) await writeAuthorizedCompanies(authorizedCompaniesFile, values);
    });
    authorizationWrites = update;
    return update;
  }

  /**
   * Before the runtime starts: the local server reads these to give every
   * workspace AIOPC's MCP, skills and instructions.
   */
  function configureEnvironment() {
    if (status === "unavailable") {
      log.warn?.(`[aiopc] ${error}`);
      return;
    }
    process.env.AIOPC_SERVICE_DIR = serviceDir;
    process.env.AIOPC_UV = uv;
    process.env.AIOPC_HOME = home;
    process.env.AIOPC_AUTHORIZED_COMPANIES_FILE = authorizedCompaniesFile;
    process.env.AIOPC_HTTP_CONNECTION_FILE = httpConnectionFile;
    // One environment shared by the API process and every workspace's MCP, outside the app bundle.
    process.env.UV_PROJECT_ENVIRONMENT = path.join(home, "venv");
    configureAiopcQmd({ app, desktopRoot });
    configureAiopcScheduler({ app, desktopRoot, serviceDir, uv, home });
    // Tools AIOPC installs for the agent (e.g. the GitHub CLI) live here; the runtime's shells inherit it.
    const toolDir = path.join(home, "bin");
    if (!String(process.env.PATH ?? "").split(path.delimiter).includes(toolDir)) {
      process.env.PATH = [toolDir, process.env.PATH].filter(Boolean).join(path.delimiter);
    }
  }

  async function waitHealthy(target, startedChild) {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline && child === startedChild) {
      try {
        // loopback-fetch: the AIOPC service health check on 127.0.0.1
        const response = await fetch(`${target}/api/health`);
        if (response.ok) return true;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  async function start() {
    if (status === "unavailable" || child) return;
    await syncAuthorizedRoots();
    stopping = false;
    status = "starting";
    const port = await freePort(PREFERRED_PORT);
    url = `http://127.0.0.1:${port}`;
    await writeAiopcHttpConnection(httpConnectionFile, { url, token });
    const args = aiopcServerArgs(serviceDir, port);
    const started = spawn(uv, args, {
      cwd: home,
      env: { ...process.env, AIOPC_TOKEN: token, AIOPC_HOME: home, UV_PROJECT_ENVIRONMENT: path.join(home, "venv") },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child = started;
    let stderr = "";
    started.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    started.on("error", (spawnError) => {
      error = `业务服务启动失败：${spawnError.message}`;
    });
    started.on("exit", (code) => {
      if (child !== started) return;
      child = null;
      if (stopping) {
        status = "stopped";
        return;
      }
      status = "failed";
      error = `业务服务已退出（${code ?? "signal"}）${stderr.trim() ? `：${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`;
      log.warn?.(`[aiopc] ${error}`);
      if (restarts < MAX_RESTARTS) {
        restarts += 1;
        setTimeout(() => void start(), 1000 * restarts);
      }
    });
    if (await waitHealthy(url, started)) {
      status = "ready";
      error = "";
      restarts = 0;
    } else if (child === started) {
      status = "failed";
      error = "业务服务没有按时就绪";
    }
  }

  async function stop() {
    stopping = true;
    const running = child;
    if (!running) { await rm(httpConnectionFile, { force: true }); return; }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { running.kill("SIGKILL"); } catch {}
        resolve(undefined);
      }, 3000);
      running.once("exit", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      try { running.kill("SIGTERM"); } catch { resolve(undefined); }
    });
    await rm(httpConnectionFile, { force: true });
  }

  /** What the renderer needs to call the API; the token never leaves this machine. */
  function connection() {
    return { status, url: status === "ready" ? url : "", token: status === "ready" ? token : "", error, home };
  }

  return { configureEnvironment, syncAuthorizedRoots, start, stop, connection };
}
