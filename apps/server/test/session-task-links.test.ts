import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiError } from "../src/errors.js";
import { matchRoute, type RequestContext, type Route } from "../src/routes/registry.js";
import { registerSessionGroupRoutes } from "../src/routes/session-groups.js";
import { getSessionGroupEventStore, readSessionGroupState, registerCreatedSessionGroup } from "../src/session-groups.js";
import type { ServerConfig, WorkspaceInfo } from "../src/types.js";

test("task links use the session's immutable project, persist, and survive native fork", async (t) => {
  const company = await realpath(await mkdtemp(join(tmpdir(), "aiopc-task-links-")));
  t.after(() => rm(company, { recursive: true, force: true }));
  const config = { configPath: join(company, ".runtime", "server.json") } as ServerConfig;
  const workspace = { id: "company", path: company } as WorkspaceInfo;
  const alpha = join(company, "projects", "alpha");
  const beta = join(company, "projects", "beta");
  await mkdir(join(alpha, "tasks"), { recursive: true });
  await mkdir(join(beta, "tasks"), { recursive: true });
  await writeFile(join(alpha, "tasks", "alpha-task.md"), "---\ntitle: Alpha\n---\n");
  await writeFile(join(beta, "tasks", "beta-task.md"), "---\ntitle: Beta\n---\n");
  await registerCreatedSessionGroup(config, workspace, { sessionId: "ses_alpha", executionDirectory: alpha });
  await registerCreatedSessionGroup(config, workspace, { sessionId: "ses_beta", executionDirectory: beta });
  await registerCreatedSessionGroup(config, workspace, { sessionId: "ses_company", executionDirectory: company });

  const routes: Route[] = [];
  registerSessionGroupRoutes({
    routes, config,
    jsonResponse: (data, status = 200) => Response.json(data, { status }),
    readJsonBody: async (request) => await request.json() as Record<string, unknown>,
    ensureWritable: () => undefined,
    requireClientScope: () => undefined,
    resolveWorkspace: async () => workspace,
    resolveWorkspaceWithoutBootstrap: async () => workspace,
  });
  async function request(method: string, suffix: string, body?: unknown) {
    const url = new URL(`http://localhost/workspace/company/session-groups${suffix}`);
    const route = matchRoute(routes, method, url.pathname);
    assert.ok(route, `${method} ${url.pathname}`);
    const request = new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await route.handler({ request, url, params: route.params, config } as RequestContext);
    assert.equal(response.status, 200);
    return await response.json() as { state: Awaited<ReturnType<typeof readSessionGroupState>>["state"] };
  }
  const task = (sessionId: string, taskId: string | null, expectedTaskId?: string | null) =>
    request("PATCH", `/task/${sessionId}`, { taskId, expectedTaskId });
  const errorStatus = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
  await assert.rejects(task("ses_unknown", "alpha-task"), errorStatus(409));
  await assert.rejects(task("ses_company", "alpha-task"), errorStatus(409));
  await assert.rejects(task("ses_alpha", "beta-task"), errorStatus(404));
  await assert.rejects(task("ses_beta", "alpha-task"), errorStatus(404));
  await assert.rejects(task("ses_alpha", "../beta-task"), errorStatus(400));

  const attached = await task("ses_alpha", "alpha-task", null);
  assert.equal(attached.state.sessionMeta.ses_alpha?.taskId, "alpha-task");
  assert.equal((await task("ses_alpha", "alpha-task", null)).state.sessionMeta.ses_alpha?.taskId, "alpha-task");
  await assert.rejects(task("ses_alpha", null, "another-task"), errorStatus(409));
  assert.equal((await readSessionGroupState(config, workspace.id)).state.sessionMeta.ses_alpha?.taskId, "alpha-task");
  const imported = structuredClone(attached.state);
  imported.sessionMeta.ses_alpha!.taskId = "beta-task";
  await assert.rejects(request("PUT", "", { state: imported }), errorStatus(409));
  await request("PATCH", "/meta/ses_alpha", { agentName: "designer" });
  await registerCreatedSessionGroup(config, workspace, { sessionId: "ses_fork", executionDirectory: alpha, parentSessionId: "ses_alpha" });
  await registerCreatedSessionGroup(config, workspace, { sessionId: "ses_other_project", executionDirectory: beta, parentSessionId: "ses_alpha" });
  const afterFork = await request("GET", "");
  assert.equal(afterFork.state.sessionMeta.ses_fork?.taskId, "alpha-task");
  assert.equal(afterFork.state.sessionMeta.ses_fork?.agentName, "designer");
  assert.equal(afterFork.state.sessionMeta.ses_other_project?.taskId, undefined);

  const detached = await task("ses_alpha", null, "alpha-task");
  assert.deepEqual(detached.state.sessionMeta.ses_alpha, { projectId: "proj:alpha", agentName: "designer" });
  const events = getSessionGroupEventStore(config).list(workspace.id, 0);
  assert.ok(events.some((event) => event.action === "meta" && event.sessionId === "ses_alpha"));
});
