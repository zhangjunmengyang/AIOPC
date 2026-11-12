import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createCompanyProject, listCompanyProjects } from "../company-projects.js";
import { ApiError } from "../errors.js";
import {
  createSessionGroupId,
  getSessionGroupEventStore,
  normalizeSessionGroupState,
  readSessionGroupState,
  sessionGroupSnapshot,
  synchronizeSessionProjectGroups,
  updateSessionGroupState,
  type SessionGroupDefinition,
  type SessionGroupState,
} from "../session-groups.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

interface RegisterSessionGroupRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  resolveWorkspaceWithoutBootstrap: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

export function registerSessionGroupRoutes(options: RegisterSessionGroupRoutesOptions): void {
  const {
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    resolveWorkspaceWithoutBootstrap,
  } = options;
  const sessionGroupEvents = getSessionGroupEventStore(config);
  const immutableProject = () => new ApiError(409, "session_project_immutable", "会话创建后不能更改所属项目，请在目标项目新建会话");

  async function updateWorkspaceSessionGroups(
    workspace: WorkspaceInfo,
    updater: (current: SessionGroupState) => SessionGroupState,
  ) {
    const projects = await listCompanyProjects(workspace.path);
    const result = await updateSessionGroupState(config, workspace.id, (current) =>
      synchronizeSessionProjectGroups(updater(synchronizeSessionProjectGroups(current, projects)), projects));
    return { ...result, state: sessionGroupSnapshot(result.state, projects) };
  }

  function protectProjectGroup(groupId: string): void {
    if (groupId.startsWith("proj:")) {
      throw new ApiError(409, "project_group_readonly", "项目分组不能改名或删除");
    }
  }

  function requireStringField(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new ApiError(400, "invalid_payload", `${field} is required`);
    }
    return value.trim();
  }

  addRoute(routes, "GET", "/workspace/:id/session-groups", "client", async (ctx) => {
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const result = await readSessionGroupState(config, workspace.id);
    const state = sessionGroupSnapshot(result.state, await listCompanyProjects(workspace.path));
    return jsonResponse({ state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PUT", "/workspace/:id/session-groups", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const state = normalizeSessionGroupState(body.state);
    const result = await updateWorkspaceSessionGroups(workspace, (current) => {
      const currentProjects = current.groups.filter((group) => group.id.startsWith("proj:"));
      const requestedProjects = state.groups.filter((group) => group.id.startsWith("proj:"));
      if (currentProjects.length !== requestedProjects.length || currentProjects.some((project) =>
        !requestedProjects.some((group) => group.id === project.id && group.label === project.label))) {
        throw new ApiError(409, "project_group_readonly", "导入分组不能增加、改名或删除项目分组");
      }
      const sessionMeta = { ...current.sessionMeta };
      for (const [id, meta] of Object.entries(state.sessionMeta)) {
        if (Object.hasOwn(meta, "projectId") && meta.projectId !== current.sessionMeta[id]?.projectId) {
          throw immutableProject();
        }
        sessionMeta[id] = { ...current.sessionMeta[id], ...meta };
      }
      const assignments = { ...state.assignments };
      for (const [id, groupId] of Object.entries(current.assignments)) {
        if (current.sessionMeta[id]?.projectId && !assignments[id] && state.groups.some((group) => group.id === groupId)) {
          assignments[id] = groupId;
        }
      }
      return { ...state, assignments, sessionMeta };
    });
    sessionGroupEvents.record(workspace.id, "imported");
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "POST", "/workspace/:id/session-groups", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    let label = requireStringField(body, "label").slice(0, 120);
    let requestedId = typeof body.id === "string" ? body.id.trim() : "";
    if (requestedId.startsWith("proj:")) {
      const name = requestedId.slice("proj:".length);
      if (body.label !== name) throw new ApiError(400, "invalid_project_name", "项目分组名称必须与目录名称一致");
      if (body.directory !== undefined) {
        if (typeof body.directory !== "string" || !isAbsolute(body.directory)) {
          throw new ApiError(400, "invalid_project_directory", "项目目录必须是公司内的绝对路径");
        }
        const company = await realpath(workspace.path);
        const expected = join(company, "projects", name);
        const requested = await realpath(body.directory).catch(() => resolve(body.directory as string));
        if (requested !== expected) throw new ApiError(400, "invalid_project_directory", "项目目录必须与项目名称一致");
      }
      const project = await createCompanyProject(workspace.path, name);
      requestedId = project.id;
      label = project.name;
    } else {
      requestedId = requestedId.slice(0, 128);
    }
    let groupId = requestedId;
    const result = await updateWorkspaceSessionGroups(workspace, (current) => {
      const existingIds = new Set(current.groups.map((group) => group.id));
      if (requestedId.startsWith("proj:") && existingIds.has(requestedId)) return current;
      const id = requestedId && !existingIds.has(requestedId) ? requestedId : createSessionGroupId();
      groupId = id;
      return { ...current, groups: [...current.groups, { id, label }] };
    });
    sessionGroupEvents.record(workspace.id, "created", groupId ? { groupId } : undefined);
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/reorder", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const requestedIds = Array.isArray(body.groupIds)
      ? body.groupIds.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : [];
    const result = await updateWorkspaceSessionGroups(workspace, (current) => {
      const byId = new Map(current.groups.map((group) => [group.id, group]));
      const used = new Set<string>();
      const groups: SessionGroupDefinition[] = [];
      for (const id of requestedIds) {
        const group = byId.get(id);
        if (!group || used.has(id)) continue;
        groups.push(group);
        used.add(id);
      }
      for (const group of current.groups) {
        if (!used.has(group.id)) groups.push(group);
      }
      return { ...current, groups };
    });
    sessionGroupEvents.record(workspace.id, "reordered");
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/assignments/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId || sessionId.length > 256) throw new ApiError(400, "invalid_payload", "sessionId is invalid");
    const body = await readJsonBody(ctx.request);
    const groupId = typeof body.groupId === "string" && body.groupId.trim() ? body.groupId.trim() : null;
    const result = await updateWorkspaceSessionGroups(workspace, (current) => {
      const assignments = { ...current.assignments };
      if (groupId === null || groupId.startsWith("proj:")) {
        const meta = current.sessionMeta[sessionId];
        if (!meta || !Object.hasOwn(meta, "projectId")) {
          throw new ApiError(409, "session_project_uninitialized", "会话所属项目尚未初始化，请刷新会话后重试");
        }
        if (meta.projectId !== groupId) throw immutableProject();
        if (groupId === null) delete assignments[sessionId];
      } else if (current.groups.some((group) => group.id === groupId)) {
        assignments[sessionId] = groupId;
      } else {
        throw new ApiError(404, "group_not_found", "分组不存在");
      }
      return { ...current, assignments };
    });
    sessionGroupEvents.record(workspace.id, "assigned", { sessionId, ...(groupId ? { groupId } : {}) });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/meta/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId || sessionId.length > 256) throw new ApiError(400, "invalid_payload", "sessionId is invalid");
    const body = await readJsonBody(ctx.request);
    if (Object.hasOwn(body, "projectId")) throw immutableProject();
    if (body.agentName !== null && (typeof body.agentName !== "string" || !body.agentName.trim() || body.agentName.trim().length > 256)) {
      throw new ApiError(400, "invalid_payload", "agentName must be a non-empty string or null");
    }
    const agentName = typeof body.agentName === "string" ? body.agentName.trim() : null;
    const result = await updateWorkspaceSessionGroups(workspace, (current) => {
      const meta = { ...current.sessionMeta[sessionId] };
      if (agentName) meta.agentName = agentName;
      else delete meta.agentName;
      return { ...current, sessionMeta: { ...current.sessionMeta, [sessionId]: meta } };
    });
    sessionGroupEvents.record(workspace.id, "meta", { sessionId });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/:groupId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const groupId = (ctx.params.groupId ?? "").trim();
    if (!groupId) throw new ApiError(400, "invalid_payload", "groupId is required");
    protectProjectGroup(groupId);
    const body = await readJsonBody(ctx.request);
    const label = requireStringField(body, "label").slice(0, 120);
    const result = await updateWorkspaceSessionGroups(workspace, (current) => ({
      ...current,
      groups: current.groups.map((group) => group.id === groupId ? { ...group, label } : group),
    }));
    sessionGroupEvents.record(workspace.id, "updated", { groupId });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "DELETE", "/workspace/:id/session-groups/:groupId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const groupId = (ctx.params.groupId ?? "").trim();
    if (!groupId) throw new ApiError(400, "invalid_payload", "groupId is required");
    protectProjectGroup(groupId);
    const requestedDestinationGroupId = ctx.url.searchParams.get("destinationGroupId")?.trim() || null;
    if (requestedDestinationGroupId?.startsWith("proj:")) {
      throw immutableProject();
    }
    const result = await updateWorkspaceSessionGroups(workspace, (current) => {
      const destinationGroupId = requestedDestinationGroupId && current.groups.some(
        (group) => group.id === requestedDestinationGroupId && group.id !== groupId,
      ) ? requestedDestinationGroupId : null;
      const assignments: Record<string, string> = {};
      for (const [sessionId, assignedGroupId] of Object.entries(current.assignments)) {
        if (assignedGroupId !== groupId) {
          assignments[sessionId] = assignedGroupId;
        } else if (destinationGroupId) {
          assignments[sessionId] = destinationGroupId;
        }
      }
      return {
        ...current,
        groups: current.groups.filter((group) => group.id !== groupId),
        assignments,
      };
    });
    sessionGroupEvents.record(workspace.id, "deleted", { groupId });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "GET", "/workspace/:id/session-groups/events", "client", async (ctx) => {
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const sinceRaw = ctx.url.searchParams.get("since");
    const since = sinceRaw ? Number(sinceRaw) : undefined;
    const items = sessionGroupEvents.list(workspace.id, since);
    return jsonResponse({ items, cursor: sessionGroupEvents.cursor(workspace.id), workspaceId: workspace.id });
  });

}
