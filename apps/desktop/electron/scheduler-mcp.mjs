import { spawn } from "node:child_process";
import os from "node:os";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const { default: SchedulerPlugin } = await import(new URL("./plugin.mjs", import.meta.url).href);

const sdkRoot = process.env.AIOPC_SCHEDULER_SDK;
if (!sdkRoot) throw new Error("AIOPC scheduler SDK path is missing.");
const { McpServer } = await import(pathToFileURL(path.join(sdkRoot, "dist/esm/server/mcp.js")).href);
const { StdioServerTransport } = await import(pathToFileURL(path.join(sdkRoot, "dist/esm/server/stdio.js")).href);
const workspace = await realpath(process.cwd());
const plugin = await SchedulerPlugin();
const server = new McpServer({ name: "aiopc-scheduler", version: "1.0.0" });
const tools = ["schedule_job", "list_jobs", "get_job", "update_job", "delete_job", "run_job", "job_logs", "get_version"];
const scoped = new Set(["get_job", "update_job", "delete_job", "run_job", "job_logs"]);
for (const name of tools) {
  const definition = plugin.tool[name];
  if (!definition) continue;
  const inputSchema = name === "run_job" ? { name: definition.args.name } : Object.fromEntries(Object.entries(definition.args).filter(([key]) => !["share", "attachUrl", "allScopes", "includeLegacy", "scopeRoot", "workdir", "agent", "continue", "session", "port", "command", "arguments", "files", "source"].includes(key)));
  server.registerTool(name, {
    description: `${definition.description} AIOPC keeps jobs in this project. Background runs save local files and cannot publish, send messages, log in, or request approval.`,
    inputSchema,
  }, async (input) => {
    const args = { ...input, format: "json", workdir: workspace, scopeRoot: workspace, allScopes: false, includeLegacy: false };
    if (scoped.has(name)) {
      const found = JSON.parse(await plugin.tool.get_job.execute({ name: args.name, format: "json" }));
      const job = found.data?.job;
      if (!job || await realpath(job.workdir).catch(() => "") !== workspace) {
        return { isError: true, content: [{ type: "text", text: "This job does not belong to the current project." }] };
      }
    }
    if (name === "run_job") {
      const found = JSON.parse(await plugin.tool.get_job.execute({ name: args.name, format: "json" }));
      const job = found.data.job;
      const root = path.join(os.homedir(), ".config", "opencode", "scheduler");
      const jobPath = path.join(root, "scopes", job.scopeId, "jobs", `${job.slug}.json`);
      // Use the same supervisor as calendar runs: it owns timeout, overlap lock,
      // result status and logs even after this short-lived MCP process closes.
      const pid = await new Promise((resolve, reject) => {
        const child = spawn("/usr/bin/perl", [fileURLToPath(new URL("./supervisor.pl", import.meta.url)), jobPath], {
          cwd: workspace, env: { ...process.env, AIOPC_SCHEDULER_RUN_SOURCE: "manual" },
          detached: true, stdio: "ignore",
        });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(child.pid); });
      });
      return { content: [{ type: "text", text: `Started ${job.name}. Check get_job or job_logs for the result.` }], structuredContent: { success: true, pid } };
    }
    if (["schedule_job", "update_job", "run_job"].includes(name)) {
      args.timeoutSeconds = Math.min(3600, Math.max(1, Number(args.timeoutSeconds) || 600));
    }
    const result = JSON.parse(await definition.execute(args));
    return { isError: result.success === false, content: [{ type: "text", text: result.output ?? JSON.stringify(result) }], structuredContent: result };
  });
}
await server.connect(new StdioServerTransport());
