import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEDULED_PERMISSIONS = Object.freeze({
  "*": "deny",
  read: "allow", glob: "allow", grep: "allow", list: "allow",
  edit: "allow", write: "allow", webfetch: "allow", websearch: "allow",
  "aiopc_social_platforms": "allow", "aiopc_social_accounts": "allow",
  "aiopc_social_read": "allow", "aiopc_social_history": "allow",
  "aiopc_library_*": "allow",
  question: "deny", external_directory: "deny",
});

export function scheduledArguments(args) {
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) return args;
  if (args[0] !== "run") throw new Error("Scheduled jobs must use opencode run.");
  const result = ["run", "--agent", "aiopc-scheduled"];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") return [...result, ...args.slice(index)];
    if (arg === "--share" || arg.startsWith("--share=") || arg === "--attach" || arg.startsWith("--attach=")) {
      throw new Error("Scheduled jobs run locally and cannot share or attach to a desktop server.");
    }
    if (arg === "--agent") { index += 1; continue; }
    if (arg.startsWith("--agent=")) continue;
    if (arg.startsWith("-") && !["--model", "-m", "--variant", "--title", "--format"].includes(arg.split("=")[0])) {
      throw new Error(`Unsupported background-run option: ${arg}`);
    }
    result.push(arg);
  }
  return result;
}

export function scheduledConfig(settings) {
  return {
    $schema: "https://opencode.ai/config.json",
    default_agent: "aiopc-scheduled",
    share: "disabled",
    permission: SCHEDULED_PERMISSIONS,
    instructions: [path.join(settings.serviceDir, "instructions.md")],
    skills: { paths: [path.join(settings.serviceDir, "skills")] },
    mcp: {
      aiopc: {
        type: "local", enabled: true, timeout: 120_000,
        command: [settings.uv, "run", "--project", settings.serviceDir, "--frozen", "--no-dev", "--quiet", "python", "-m", "aiopc.server", "--stdio"],
        environment: { AIOPC_HOME: settings.home, UV_PROJECT_ENVIRONMENT: path.join(settings.home, "venv"), ...(settings.library ? { AIOPC_LIBRARY: settings.library } : {}) },
      },
    },
    agent: {
      "aiopc-scheduled": {
        description: "本地后台任务：读取资料、生成报告和提醒文件",
        mode: "primary",
        prompt: "你正在独立运行一个已设定的后台任务，没有人在场回答问题。只读取任务需要的数据，在当前项目目录保存明确的结果、时间和来源。提醒保存为本地 Markdown 文件。不得登录账号、填写发布页、发布、发信、付款、共享会话或调用交互工具。遇到缺少权限或登录过期，写明原因并结束。不要另建定时任务。",
        permission: SCHEDULED_PERMISSIONS,
      },
    },
  };
}

export async function runScheduledJob(settingsPath, args, { cwd = process.cwd(), env = process.env } = {}) {
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  const commandArgs = scheduledArguments(args);
  const workspace = await realpath(cwd);
  const scope = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
  const stateDir = path.join(settings.home, "scheduler", "workspaces", scope);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(stateDir, "opencode.json");
  await writeFile(configPath, `${JSON.stringify(scheduledConfig(settings), null, 2)}\n`, { mode: 0o600 });
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("OPENWORK_") && (!key.startsWith("OPENCODE_") || key.startsWith("OPENCODE_SCHEDULER_"))));
  Object.assign(childEnv, {
    OPENCODE_CONFIG: configPath,
    OPENCODE_DB: path.join(stateDir, "opencode.sqlite"),
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_PERMISSION: JSON.stringify(SCHEDULED_PERMISSIONS),
    OPENCODE_DISABLE_SHARE: "true",
    AIOPC_HOME: settings.home,
    AIOPC_SERVICE_DIR: settings.serviceDir,
    AIOPC_UV: settings.uv,
    UV_PROJECT_ENVIRONMENT: path.join(settings.home, "venv"),
    PATH: [path.join(settings.home, "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
  });
  return new Promise((resolve, reject) => {
    const child = spawn(settings.opencodeBin, commandArgs, { cwd: workspace, env: childEnv, stdio: "inherit", windowsHide: true });
    const terminate = () => { child.kill("SIGTERM"); };
    process.once("SIGTERM", terminate);
    process.once("SIGINT", terminate);
    child.once("error", (error) => {
      process.removeListener("SIGTERM", terminate);
      process.removeListener("SIGINT", terminate);
      reject(error);
    });
    child.once("exit", (code) => {
      process.removeListener("SIGTERM", terminate);
      process.removeListener("SIGINT", terminate);
      resolve(code ?? 1);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runScheduledJob(path.join(path.dirname(fileURLToPath(import.meta.url)), "settings.json"), process.argv.slice(2));
  } catch (error) {
    console.error(`[aiopc-scheduler] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
