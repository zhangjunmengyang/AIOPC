import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiError } from "../src/errors.js";
import { registerCompanyOrgRoutes } from "../src/routes/company-org.js";
import { matchRoute, type RequestContext, type Route } from "../src/routes/registry.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../src/types.js";

test("org chart routes use the resolved company and only collaborators can edit reporting lines", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aiopc-org-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, ".opencode", "agent");
  const agents = join(root, ".opencode", "agents");
  await Promise.all([mkdir(agent, { recursive: true }), mkdir(agents, { recursive: true })]);
  const file = join(agent, "writer.md");
  const content = "---\ndescription: 内容\nmetadata:\n  aiopc:\n    name: 编辑\n    skills: [writing]\n---\n\n写作角色指令\n";
  await writeFile(file, content);
  await writeFile(join(agents, "lead.md"), "---\nmetadata:\n  aiopc:\n    name: 负责人\n---\n角色\n");
  const config = { readOnly: false } as ServerConfig;
  const routes: Route[] = [];
  registerCompanyOrgRoutes({
    routes,
    config,
    jsonResponse: Response.json,
    readJsonBody: (request) => request.json() as Promise<Record<string, unknown>>,
    ensureWritable: () => {
      if (config.readOnly) throw new ApiError(403, "read_only", "Read only");
    },
    requireClientScope: (ctx, scope) => {
      assert.equal(scope, "collaborator");
      if (ctx.actor?.scope !== "collaborator") throw new ApiError(403, "forbidden", "No write access");
    },
    resolveWorkspaceWithoutBootstrap: async (_, id) => {
      if (id !== "real") throw new ApiError(404, "workspace_not_found", "Company not found");
      return { id, path: root } as WorkspaceInfo;
    },
  });

  async function request(method: string, workspaceId: string, roleId?: string, body?: unknown, scope: TokenScope = "viewer") {
    const url = new URL("http://localhost/workspace/" + workspaceId + "/company/org-chart" + (roleId ? "/" + roleId : ""));
    const route = matchRoute(routes, method, url.pathname);
    assert.ok(route);
    assert.equal(route.auth, "client");
    const request = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const response = await route.handler({ request, url, params: route.params, actor: { scope }, config } as RequestContext);
    assert.equal(response.status, 200);
    return response.json();
  }

  const initial = { roles: [
    { id: "lead", name: "负责人", reportsTo: null },
    { id: "writer", name: "编辑", description: "内容", reportsTo: null },
  ] };
  assert.deepEqual(await request("GET", "real"), initial);
  await assert.rejects(request("GET", "fake"), { code: "workspace_not_found" });
  await assert.rejects(request("PATCH", "real", "writer", { reportsTo: "lead" }), { code: "forbidden" });
  config.readOnly = true;
  await assert.rejects(request("PATCH", "real", "writer", { reportsTo: "lead" }, "collaborator"), { code: "read_only" });
  config.readOnly = false;
  for (const body of [{}, { reportsTo: 1 }, { reportsTo: " " }]) {
    await assert.rejects(request("PATCH", "real", "writer", body, "collaborator"), { code: "invalid_payload" });
  }
  assert.equal(await readFile(file, "utf8"), content);

  const updated = await request("PATCH", "real", "writer", { reportsTo: "lead", workspace: "/ignored" }, "collaborator");
  assert.deepEqual(updated, { roles: [initial.roles[0], { ...initial.roles[1], reportsTo: "lead" }] });
  assert.deepEqual(await request("GET", "real"), updated);
  const persisted = await readFile(file, "utf8");
  assert.match(persisted, /aiopc:\n    name: 编辑\n    skills: \[ writing \]\n    reportsTo: lead/);
  assert.ok(persisted.endsWith("\n写作角色指令\n"));
  assert.deepEqual(await request("PATCH", "real", "writer", { reportsTo: null }, "collaborator"), initial);
});
