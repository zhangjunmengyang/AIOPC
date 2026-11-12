import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiError } from "../src/errors.js";
import { matchRoute, type RequestContext, type Route } from "../src/routes/registry.js";
import { registerSessionGroupRoutes } from "../src/routes/session-groups.js";
import { normalizeSessionGroupState, readSessionGroupState } from "../src/session-groups.js";
import * as sessionGroups from "../src/session-groups.js";
import { createWorkspaceKvStore } from "../src/workspace-kv-store.js";
import type { ServerConfig, WorkspaceInfo } from "../src/types.js";

async function harness(t: { after: (fn: () => Promise<void>) => void }) {
  const temporary = await mkdtemp(join(tmpdir(), "aiopc-session-groups-"));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { configPath: join(root, ".runtime", "server.json") } as ServerConfig;
  const workspace = { id: "company", path: root } as WorkspaceInfo;
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
  async function request(method: string, suffix = "", body?: unknown) {
    const url = new URL(`http://localhost/workspace/company/session-groups${suffix}`);
    const route = matchRoute(routes, method, url.pathname);
    assert.ok(route, `${method} ${url.pathname} must exist`);
    const request = new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await route.handler({ request, url, params: route.params, config } as RequestContext);
    assert.equal(response.status, 200);
    return await response.json() as any;
  }
  return { root, config, workspace, request };
}

test("normalization retains role bindings independently of group assignments", () => {
  const state = normalizeSessionGroupState({
    groups: [], assignments: {},
    sessionMeta: { " ses_a ": { agentName: " 品牌设计师 ", discarded: true }, ses_b: {}, bad: false },
  });
  assert.deepEqual(state.sessionMeta, { ses_a: { agentName: "品牌设计师" }, ses_b: {} });
  assert.deepEqual(normalizeSessionGroupState(null).sessionMeta, {});
});

test("role PATCH persists, emits a meta event, and clearing survives later imports and group deletion", async (t) => {
  const h = await harness(t);
  const first = await h.request("PATCH", "/meta/ses_a", { agentName: "品牌设计师" });
  assert.deepEqual(first.state.sessionMeta, { ses_a: { agentName: "品牌设计师" } });
  assert.deepEqual((await readSessionGroupState(h.config, "company")).state.sessionMeta, first.state.sessionMeta);
  const events = await h.request("GET", "/events");
  assert.deepEqual(events.items.map((item: any) => [item.action, item.sessionId]), [["meta", "ses_a"]]);
  await h.request("PUT", "", { state: { groups: [{ id: "g1", label: "待办" }], assignments: {} } });
  await h.request("DELETE", "/g1");
  assert.deepEqual((await h.request("GET")).state.sessionMeta, first.state.sessionMeta);
  await h.request("PATCH", "/meta/ses_a", { agentName: null });
  assert.deepEqual((await h.request("GET")).state.sessionMeta, { ses_a: {} });
  for (const body of [{}, { agentName: 42 }, { agentName: " " }]) {
    await assert.rejects(h.request("PATCH", "/meta/ses_a", body), (error: unknown) => error instanceof ApiError && error.status === 400);
  }
});

test("GET discovers actual project directories and keeps custom groups and their order", async (t) => {
  const h = await harness(t);
  await h.request("POST", "", { id: "custom", label: "待办" });
  await mkdir(join(h.root, "projects", "甲项目"), { recursive: true });
  await mkdir(join(h.root, "projects", "乙项目"), { recursive: true });
  await symlink(h.root, join(h.root, "projects", "outside"));
  const first = (await h.request("GET")).state;
  assert.equal(first.groups[0].id, "custom");
  assert.deepEqual(first.groups.filter((group: any) => group.id.startsWith("proj:")).map((group: any) => group.id).sort(), ["proj:乙项目", "proj:甲项目"].sort());
  await h.request("PATCH", "/reorder", { groupIds: ["proj:甲项目", "custom", "proj:乙项目"] });
  assert.deepEqual((await h.request("GET")).state.groups.map((group: any) => group.id), ["proj:甲项目", "custom", "proj:乙项目"]);
});

test("project groups cannot be renamed or deleted through individual or bulk routes", async (t) => {
  const h = await harness(t);
  await mkdir(join(h.root, "projects", "auday"), { recursive: true });
  const forbidden = (error: unknown) => error instanceof ApiError && error.status === 409;
  await assert.rejects(h.request("PATCH", "/proj%3Aauday", { label: "renamed" }), forbidden);
  await assert.rejects(h.request("DELETE", "/proj%3Aauday"), forbidden);
  await assert.rejects(h.request("PUT", "", { state: { groups: [], assignments: {} } }), forbidden);
  await assert.rejects(h.request("PUT", "", { state: { groups: [{ id: "proj:auday", label: "renamed" }], assignments: {} } }), forbidden);
  await assert.rejects(h.request("PUT", "", { state: { groups: [{ id: "proj:auday", label: "auday" }, { id: "proj:fake", label: "fake" }], assignments: {} } }), forbidden);
  assert.deepEqual((await h.request("GET")).state.groups, [{ id: "proj:auday", label: "auday" }]);
});

test("POST creates a stable project group with its real directory and rejects forged paths", async (t) => {
  const h = await harness(t);
  const directory = join(h.root, "projects", "auday");
  const created = await h.request("POST", "", { id: "proj:auday", label: "auday", directory });
  assert.equal((await stat(directory)).isDirectory(), true);
  assert.deepEqual(created.state.groups, [{ id: "proj:auday", label: "auday" }]);
  assert.deepEqual((await h.request("POST", "", { id: "proj:auday", label: "auday" })).state.groups, created.state.groups);
  const invalid = (error: unknown) => error instanceof ApiError && error.status === 400;
  for (const body of [
    { id: "proj:../escape", label: "../escape" },
    { id: "proj:hidden", label: "other" },
    { id: "proj:outside", label: "outside", directory: h.root },
  ]) await assert.rejects(h.request("POST", "", body), invalid);
  await assert.rejects(stat(join(h.root, "projects", "outside")));
});

test("concurrent role and assignment changes preserve both updates", async (t) => {
  const h = await harness(t);
  await h.request("POST", "", { id: "g1", label: "待办" });
  await Promise.all([
    h.request("PATCH", "/meta/ses_a", { agentName: "增长" }),
    h.request("PATCH", "/assignments/ses_a", { groupId: "g1" }),
  ]);
  const state = (await h.request("GET")).state;
  assert.deepEqual(state.assignments, { ses_a: "g1" });
  assert.deepEqual(state.sessionMeta, { ses_a: { agentName: "增长" } });
});

test("native project session creation persists its project group and shares route events", async (t) => {
  const h = await harness(t);
  const project = join(h.root, "projects", "auday");
  await mkdir(project, { recursive: true });
  await h.request("POST", "", { id: "drafts", label: "草稿" });
  await h.request("PATCH", "/assignments/source", { groupId: "drafts" });
  await h.request("PATCH", "/meta/source", { agentName: "品牌设计师" });
  const before = (await h.request("GET", "/events")).cursor;
  await sessionGroups.registerCreatedSessionGroup(h.config, h.workspace, {
    sessionId: "background", executionDirectory: project, parentSessionId: "source",
  });
  const stored = (await readSessionGroupState(h.config, h.workspace.id)).state;
  assert.equal(stored.assignments.background, "drafts");
  assert.deepEqual(stored.sessionMeta.background, { projectId: "proj:auday", agentName: "品牌设计师" });
  assert.deepEqual((await h.request("GET", `/events?since=${before}`)).items.map((item: any) => [item.action, item.sessionId]), [
    ["assigned", "background"], ["meta", "background"],
  ]);
  const cursor = (await h.request("GET", "/events")).cursor;
  await sessionGroups.registerCreatedSessionGroup(h.config, h.workspace, {
    sessionId: "background", executionDirectory: project, parentSessionId: "source",
  });
  assert.equal((await h.request("GET", "/events")).cursor, cursor);
  await h.request("PATCH", "/meta/background", { agentName: null });
  await h.request("PATCH", "/assignments/background", { groupId: "drafts" });
  await sessionGroups.registerCreatedSessionGroup(h.config, h.workspace, {
    sessionId: "background", executionDirectory: project, parentSessionId: "source",
  });
  const replayed = (await h.request("GET")).state;
  assert.equal(replayed.assignments.background, "proj:auday");
  assert.deepEqual(replayed.sessionMeta.background, { projectId: "proj:auday" });
});

test("forks inherit company groups and cleared roles without copying a different project group", async (t) => {
  const h = await harness(t);
  await mkdir(join(h.root, "projects", "auday"), { recursive: true });
  await h.request("POST", "", { id: "drafts", label: "草稿" });
  await h.request("PATCH", "/assignments/source", { groupId: "drafts" });
  await h.request("PATCH", "/meta/source", { agentName: null });
  await sessionGroups.registerCreatedSessionGroup(h.config, h.workspace, {
    sessionId: "fork", executionDirectory: h.root, parentSessionId: "source",
  });
  assert.equal((await h.request("GET")).state.assignments.fork, "drafts");
  assert.deepEqual((await h.request("GET")).state.sessionMeta.fork, { projectId: null });
  await sessionGroups.registerCreatedSessionGroup(h.config, h.workspace, {
    sessionId: "project-source", executionDirectory: join(h.root, "projects", "auday"),
  });
  await sessionGroups.registerCreatedSessionGroup(h.config, h.workspace, {
    sessionId: "company-fork", executionDirectory: h.root, parentSessionId: "project-source",
  });
  assert.equal((await h.request("GET")).state.assignments["company-fork"], undefined);
});

test("native group registration preserves concurrent metadata and never matches outside or nested directories", async (t) => {
  const h = await harness(t);
  const project = join(h.root, "projects", "auday");
  const nested = join(project, "nested");
  const outside = join(h.root, "another-company", "projects", "auday");
  await mkdir(nested, { recursive: true });
  await mkdir(outside, { recursive: true });
  await Promise.all([
    sessionGroups.registerCreatedSessionGroup(h.config, h.workspace, { sessionId: "one", executionDirectory: project }),
    sessionGroups.registerCreatedSessionGroup(h.config, h.workspace, { sessionId: "two", executionDirectory: project }),
    h.request("PATCH", "/meta/one", { agentName: "增长" }),
  ]);
  for (const [sessionId, executionDirectory] of [["outside", outside], ["nested", nested], ["missing", join(h.root, "projects", "missing")]]) {
    await sessionGroups.registerCreatedSessionGroup(h.config, h.workspace, { sessionId, executionDirectory });
  }
  const state = (await h.request("GET")).state;
  assert.deepEqual(state.assignments, { one: "proj:auday", two: "proj:auday" });
  assert.deepEqual(state.sessionMeta.one, { agentName: "增长", projectId: "proj:auday" });
});

test("legacy project assignments migrate once into projectId and explicit company scope wins", async () => {
  const state = normalizeSessionGroupState({
    groups: [{ id: "proj:A", label: "A" }, { id: "custom", label: "草稿" }],
    assignments: { old: "proj:A", company: "proj:A", custom: "custom" },
    sessionMeta: { old: { agentName: "设计" }, company: { projectId: null } },
  });
  assert.deepEqual(state.assignments, { custom: "custom" });
  assert.deepEqual(state.sessionMeta, { old: { agentName: "设计", projectId: "proj:A" }, company: { projectId: null } });
});

test("session project resolution initializes native cwd once and later ignores stale native directories", async (t) => {
  const h = await harness(t);
  const a = join(h.root, "projects", "A");
  const b = join(h.root, "projects", "B");
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  assert.deepEqual(await sessionGroups.resolveSessionProject(h.config, h.workspace, "old", a), { projectId: "proj:A", executionDirectory: a });
  assert.deepEqual(await sessionGroups.resolveSessionProject(h.config, h.workspace, "old", b), { projectId: "proj:A", executionDirectory: a });
  await assert.rejects(h.request("PATCH", "/assignments/old", { groupId: null }),
    (error: unknown) => error instanceof ApiError && error.code === "session_project_immutable");
  assert.deepEqual(await sessionGroups.resolveSessionProject(h.config, h.workspace, "old", a), { projectId: "proj:A", executionDirectory: a });
  assert.equal((await readSessionGroupState(h.config, h.workspace.id)).state.assignments.old, undefined);
});

test("an existing project is immutable while role and custom display grouping can change", async (t) => {
  const h = await harness(t);
  const a = join(h.root, "projects", "A");
  const b = join(h.root, "projects", "B");
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  await sessionGroups.resolveSessionProject(h.config, h.workspace, "session", a);
  await h.request("POST", "", { id: "drafts", label: "草稿" });
  await h.request("PATCH", "/meta/session", { agentName: "设计" });
  await h.request("PATCH", "/assignments/session", { groupId: "drafts" });
  for (const groupId of ["proj:B", null]) {
    await assert.rejects(h.request("PATCH", "/assignments/session", { groupId }),
      (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === "session_project_immutable");
  }
  assert.equal((await h.request("PATCH", "/assignments/session", { groupId: "proj:A" })).state.assignments.session, "proj:A");
  const stored = (await readSessionGroupState(h.config, h.workspace.id)).state;
  assert.deepEqual(stored.assignments, { session: "drafts" });
  assert.deepEqual(stored.sessionMeta.session, { projectId: "proj:A", agentName: "设计" });
  await h.request("PATCH", "/meta/session", { agentName: null });
  assert.deepEqual((await h.request("GET")).state.sessionMeta.session, { projectId: "proj:A" });
});

test("metadata and bulk imports cannot change an existing project or company-level session", async (t) => {
  const h = await harness(t);
  const a = join(h.root, "projects", "A");
  await mkdir(a, { recursive: true });
  await mkdir(join(h.root, "projects", "B"), { recursive: true });
  await sessionGroups.resolveSessionProject(h.config, h.workspace, "session", a);
  const immutable = (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === "session_project_immutable";
  await assert.rejects(h.request("PATCH", "/meta/session", { agentName: "设计", projectId: "proj:B" }), immutable);
  const snapshot = (await h.request("GET")).state;
  await assert.rejects(h.request("PUT", "", { state: { ...snapshot, sessionMeta: { session: { projectId: "proj:B" } } } }),
    immutable);
  await assert.rejects(h.request("PUT", "", { state: { ...snapshot, sessionMeta: {}, assignments: { session: "proj:B" } } }),
    immutable);
  await sessionGroups.resolveSessionProject(h.config, h.workspace, "company-session", h.root);
  await assert.rejects(h.request("PATCH", "/assignments/company-session", { groupId: "proj:A" }), immutable);
  assert.equal((await h.request("GET")).state.sessionMeta["company-session"].projectId, null);
  assert.equal((await h.request("GET")).state.sessionMeta.session.projectId, "proj:A");
});

test("frontend assignment cannot claim an unknown session as a newly created project session", async (t) => {
  const h = await harness(t);
  await mkdir(join(h.root, "projects", "A"), { recursive: true });
  await h.request("PATCH", "/meta/unknown", { agentName: "设计" });
  const uninitialized = (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === "session_project_uninitialized";
  await assert.rejects(h.request("PATCH", "/assignments/unknown", { groupId: "proj:A" }), uninitialized);
  await assert.rejects(h.request("PATCH", "/assignments/unknown", { groupId: null }), uninitialized);
  assert.deepEqual((await h.request("GET")).state.sessionMeta.unknown, { agentName: "设计" });
  await sessionGroups.registerCreatedSessionGroup(h.config, h.workspace, {
    sessionId: "unknown", executionDirectory: join(h.root, "projects", "A"),
  });
  assert.equal((await h.request("PATCH", "/assignments/unknown", { groupId: "proj:A" })).state.sessionMeta.unknown.projectId, "proj:A");
});

test("reading a legacy KV row persists its project migration without retaining a second assignment fact", async (t) => {
  const h = await harness(t);
  const legacy = createWorkspaceKvStore<any>({ tableName: "session_group_states", valueColumn: "state_json",
    extraColumns: { schemaVersion: { name: "schema_version", definition: "INTEGER NOT NULL DEFAULT 1", value: 1 } },
    parse: JSON.parse, serialize: JSON.stringify });
  await legacy.set(h.config, h.workspace.id, {
    groups: [{ id: "proj:A", label: "A" }], assignments: { session: "proj:A" }, sessionMeta: { session: { agentName: "设计" } },
  }, 1);
  const migrated = await readSessionGroupState(h.config, h.workspace.id);
  assert.deepEqual(migrated.state.sessionMeta.session, { agentName: "设计", projectId: "proj:A" });
  const saved = await legacy.getRow(h.config, h.workspace.id);
  assert.deepEqual(saved?.value.assignments, {});
  assert.deepEqual(saved?.value.sessionMeta.session, { agentName: "设计", projectId: "proj:A" });
  assert.equal((await readSessionGroupState(h.config, h.workspace.id)).updatedAt, migrated.updatedAt);
});

test("round-tripping a derived snapshot preserves custom display grouping and group deletion never changes project scope", async (t) => {
  const h = await harness(t);
  const project = join(h.root, "projects", "A");
  await mkdir(project, { recursive: true });
  await h.request("POST", "", { id: "drafts", label: "草稿" });
  await h.request("PATCH", "/assignments/session", { groupId: "drafts" });
  await sessionGroups.resolveSessionProject(h.config, h.workspace, "session", project);
  await h.request("PUT", "", { state: (await h.request("GET")).state });
  assert.equal((await readSessionGroupState(h.config, h.workspace.id)).state.assignments.session, "drafts");
  await assert.rejects(h.request("DELETE", "/drafts?destinationGroupId=proj%3AA"),
    (error: unknown) => error instanceof ApiError && error.status === 409);
  await h.request("DELETE", "/drafts");
  const state = (await h.request("GET")).state;
  assert.equal(state.assignments.session, "proj:A");
  assert.equal(state.sessionMeta.session.projectId, "proj:A");
});
