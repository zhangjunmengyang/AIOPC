import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CompanyGoalSnapshot } from "../src/company-goals.js";
import { ApiError, formatError } from "../src/errors.js";
import { registerCompanyGoalRoutes } from "../src/routes/company-goals.js";
import { matchRoute, type RequestContext, type Route } from "../src/routes/registry.js";
import type { ServerConfig, WorkspaceInfo } from "../src/types.js";

async function serveTemporaryCompany(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-goals-")));
  const config = { configPath: join(root, "runtime", "server.json") } as ServerConfig;
  const company = { id: "company", path: join(root, "company") } as WorkspaceInfo;
  const second = { id: "second", path: join(root, "second") } as WorkspaceInfo;
  const alpha = join(company.path, "projects", "甲");
  const beta = join(company.path, "projects", "乙");
  for (const path of [alpha, beta, join(second.path, "projects", "甲")]) {
    await mkdir(join(path, "tasks"), { recursive: true });
    await writeFile(join(path, "tasks", "task-1.md"), "---\ntitle: 发布首个版本\n---\n");
  }
  const routes: Route[] = [];
  registerCompanyGoalRoutes({
    routes, config,
    jsonResponse: (body, status) => Response.json(body, { status }),
    readJsonBody: async (request) => await request.json() as Record<string, unknown>,
    ensureWritable: () => undefined,
    requireClientScope: ({ request }, scope) => {
      assert.equal(scope, "collaborator");
      if (request.headers.get("Authorization") !== "Bearer collaborator") {
        throw new ApiError(403, "insufficient_scope", "权限不足");
      }
    },
    resolveWorkspaceWithoutBootstrap: async (_, id) => {
      if (id === company.id) return company;
      if (id === second.id) return second;
      throw new ApiError(404, "workspace_not_found", "公司不存在");
    },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const route = matchRoute(routes, request.method, url.pathname);
      if (!route) return new Response(null, { status: 404 });
      try {
        return await route.handler({ request, url, params: route.params, config } as RequestContext);
      } catch (error) {
        if (error instanceof ApiError) return Response.json(formatError(error), { status: error.status });
        throw error;
      }
    },
  });
  t.after(async () => {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  async function request(method = "GET", suffix = "", body?: unknown, options: {
    companyId?: string; auth?: string; status?: number;
  } = {}): Promise<CompanyGoalSnapshot> {
    const response = await fetch(new URL(`/workspace/${options.companyId ?? company.id}/goals${suffix}`, server.url), {
      method,
      headers: { Authorization: `Bearer ${options.auth ?? "collaborator"}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json() as CompanyGoalSnapshot;
    assert.equal(response.status, options.status ?? (method === "POST" ? 201 : 200), JSON.stringify(data));
    return data;
  }

  const createCompany = (title: string) => request("POST", "", { title, projectId: null, parentId: null });
  const createProject = (title: string, parentId: string, projectId = "proj:甲") =>
    request("POST", "", { title, projectId, parentId });
  const setLink = (projectId: string, taskId: string, goalId: string | null, status = 200) =>
    request("PATCH", `/task-links/${encodeURIComponent(projectId)}/${encodeURIComponent(taskId)}`, { goalId }, { status });
  return { alpha, beta, company, request, createCompany, createProject, setLink };
}

test("company and project goals are persisted, editable, and scoped to the requested company", async (t) => {
  const h = await serveTemporaryCompany(t);
  const empty = await h.request();
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.projects.map((item) => item.id).sort(), ["proj:乙", "proj:甲"].sort());
  const first = await h.createCompany("公司目标");
  const parent = first.items[0]!;
  const saved = await h.createProject("首版目标", parent.id);
  const projectGoal = saved.items.find((item) => item.projectId === "proj:甲")!;
  assert.equal(projectGoal.parentId, parent.id);
  const changed = await h.request("PATCH", `/${projectGoal.id}`, { title: "发布首版", description: "包含离线体验", status: "active" });
  assert.equal(changed.items.find((item) => item.id === projectGoal.id)?.status, "active");
  assert.deepEqual(await h.request(), changed);
  assert.deepEqual((await h.request("GET", "", undefined, { companyId: "second" })).items, []);
  await h.request("PATCH", `/${projectGoal.id}`, { title: "越权更新" }, { auth: "viewer", status: 403 });
});

test("goal hierarchy rejects missing parents, cycles, foreign projects, and changing goal scope", async (t) => {
  const h = await serveTemporaryCompany(t);
  const parent = (await h.createCompany("公司目标")).items[0]!;
  const project = (await h.createProject("项目目标", parent.id)).items.find((item) => item.projectId)!;
  await h.request("POST", "", { title: "孤立项目目标", projectId: "proj:甲", parentId: null }, { status: 400 });
  await h.request("POST", "", { title: "伪造项目目标", projectId: "proj:不存在", parentId: parent.id }, { status: 404 });
  await h.request("POST", "", { title: "嵌套项目目标", projectId: "proj:甲", parentId: project.id }, { status: 400 });
  await h.request("PATCH", `/${parent.id}`, { parentId: project.id }, { status: 400 });
  await h.request("PATCH", `/${project.id}`, { projectId: "proj:乙" }, { status: 400 });
});

test("task and goal views derive from one link, including reassign and unlink", async (t) => {
  const h = await serveTemporaryCompany(t);
  const parent = (await h.createCompany("公司目标")).items[0]!;
  const goal = (await h.createProject("首版", parent.id)).items.find((item) => item.title === "首版")!;
  const replacement = (await h.createProject("迭代", parent.id)).items.find((item) => item.title === "迭代")!;
  const otherProject = (await h.createProject("另一个项目", parent.id, "proj:乙")).items.find((item) => item.projectId === "proj:乙")!;
  const linked = await h.setLink("proj:甲", "task-1", goal.id);
  assert.deepEqual(linked.links.filter((item) => item.goalId === goal.id), [{ goalId: goal.id, projectId: "proj:甲", taskId: "task-1" }]);
  assert.equal((await h.request()).links.find((item) => item.projectId === "proj:甲" && item.taskId === "task-1")?.goalId, goal.id);
  await h.setLink("proj:甲", "task-1", otherProject.id, 400);
  await h.setLink("proj:甲", "task-1", parent.id, 400);
  await h.setLink("proj:甲", "missing", goal.id, 404);
  await symlink(join(h.beta, "tasks", "task-1.md"), join(h.alpha, "tasks", "foreign.md"));
  await h.setLink("proj:甲", "foreign", goal.id, 404);
  const reassigned = await h.setLink("proj:甲", "task-1", replacement.id);
  assert.deepEqual(reassigned.links, [{ goalId: replacement.id, projectId: "proj:甲", taskId: "task-1" }]);
  assert.deepEqual((await h.setLink("proj:甲", "task-1", null)).links, []);
});

test("concurrent changes are preserved and duplicate task IDs stay in their own projects", async (t) => {
  const h = await serveTemporaryCompany(t);
  await Promise.all([h.createCompany("公司甲"), h.createCompany("公司乙")]);
  const roots = (await h.request()).items;
  assert.equal(roots.length, 2);
  await Promise.all([h.createProject("项目甲", roots[0]!.id), h.createProject("项目乙", roots[1]!.id, "proj:乙")]);
  const goals = (await h.request()).items;
  await Promise.all(goals.flatMap((item) => item.projectId ? [h.setLink(item.projectId, "task-1", item.id)] : []));
  assert.deepEqual((await h.request()).links.map((item) => item.projectId).sort(), ["proj:甲", "proj:乙"].sort());
});
