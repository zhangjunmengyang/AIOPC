import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isCompanyProjectName, listCompanyProjects, type CompanyProject } from "./company-projects.js";
import { ApiError } from "./errors.js";
import { runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { shortId } from "./utils.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

export type SessionGroupDefinition = {
  id: string;
  label: string;
};

export type SessionGroupState = {
  groups: SessionGroupDefinition[];
  assignments: Record<string, string>;
  sessionMeta: Record<string, SessionMetadata>;
};

/** Missing projectId is a legacy record; explicit null permanently means company scope. */
export type SessionMetadata = { agentName?: string; projectId?: string | null };
export type SessionProject = { projectId: string | null; executionDirectory: string };

export type SessionGroupEventAction = "created" | "updated" | "deleted" | "assigned" | "reordered" | "imported" | "meta";

export type SessionGroupEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  type: "session_groups.updated";
  action: SessionGroupEventAction;
  groupId?: string;
  sessionId?: string;
  timestamp: number;
};

const EMPTY_SESSION_GROUP_STATE: SessionGroupState = { groups: [], assignments: {}, sessionMeta: {} };

type SessionGroupEventState = {
  seq: number;
  events: SessionGroupEvent[];
};

function isProjectGroupId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("proj:") && isCompanyProjectName(value.slice(5));
}

function normalizeGroupId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.startsWith("proj:")) return isProjectGroupId(trimmed) ? trimmed : "";
  return trimmed.slice(0, 128);
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 120);
}

export function createSessionGroupId(): string {
  return `grp_${Date.now().toString(36)}_${shortId()}`;
}

export function normalizeSessionGroupState(value: unknown): SessionGroupState {
  if (!isRecord(value)) return EMPTY_SESSION_GROUP_STATE;

  const groups: SessionGroupDefinition[] = [];
  const seenGroupIds = new Set<string>();
  if (Array.isArray(value.groups)) {
    for (const item of value.groups) {
      if (!isRecord(item)) continue;
      const id = normalizeGroupId(item.id);
      const label = id.startsWith("proj:") && typeof item.label === "string"
        ? Array.from(item.label.trim()).slice(0, 120).join("")
        : normalizeLabel(item.label);
      if (!id || !label || seenGroupIds.has(id)) continue;
      groups.push({ id, label });
      seenGroupIds.add(id);
    }
  }

  const assignments: Record<string, string> = {};
  if (isRecord(value.assignments)) {
    for (const [sessionId, rawGroupId] of Object.entries(value.assignments)) {
      const normalizedSessionId = sessionId.trim().slice(0, 256);
      const groupId = normalizeGroupId(rawGroupId);
      if (!normalizedSessionId || !groupId || !seenGroupIds.has(groupId)) continue;
      assignments[normalizedSessionId] = groupId;
    }
  }

  const sessionMeta: Record<string, SessionMetadata> = Object.fromEntries(
    Object.entries(isRecord(value.sessionMeta) ? value.sessionMeta : {}).flatMap(([sessionId, rawMeta]) => {
      const id = sessionId.trim().slice(0, 256);
      if (!id || !isRecord(rawMeta)) return [];
      const agentName = typeof rawMeta.agentName === "string" ? rawMeta.agentName.trim().slice(0, 256) : "";
      const projectId = rawMeta.projectId === null || isProjectGroupId(rawMeta.projectId) ? rawMeta.projectId : undefined;
      return [[id, { ...(agentName ? { agentName } : {}), ...(projectId !== undefined ? { projectId } : {}) }]];
    }),
  );

  // One-time legacy migration. Project assignments are never serialized as a second source of truth.
  for (const [sessionId, groupId] of Object.entries(assignments)) {
    if (!groupId.startsWith("proj:")) continue;
    if (!Object.hasOwn(sessionMeta[sessionId] ?? {}, "projectId")) {
      sessionMeta[sessionId] = { ...sessionMeta[sessionId], projectId: groupId };
    }
    delete assignments[sessionId];
  }

  return { groups, assignments, sessionMeta };
}

/** Real project directories own reserved group names; custom group order survives discovery. */
export function synchronizeSessionProjectGroups(state: SessionGroupState, projects: readonly CompanyProject[]): SessionGroupState {
  const remaining = new Map(projects.map((project) => [project.id, { id: project.id, label: project.name }]));
  const groups = state.groups.flatMap((group) => {
    if (!group.id.startsWith("proj:")) return [group];
    const project = remaining.get(group.id);
    remaining.delete(group.id);
    return project ? [project] : [];
  });
  return normalizeSessionGroupState({ ...state, groups: [...groups, ...remaining.values()] });
}

/** Compatibility view for the sidebar. Never write this derived assignment map directly. */
export function sessionGroupSnapshot(state: SessionGroupState, projects: CompanyProject[]): SessionGroupState {
  const snapshot = synchronizeSessionProjectGroups(state, projects);
  const available = new Set(projects.map((project) => project.id));
  for (const [id, meta] of Object.entries(snapshot.sessionMeta)) {
    if (meta.projectId && available.has(meta.projectId)) snapshot.assignments[id] = meta.projectId;
  }
  return snapshot;
}

const updateQueueByWorkspace = new Map<string, Promise<void>>();

async function queuedSessionGroupUpdate<T>(config: ServerConfig, workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const key = `${runtimeDbPath(config)}:${workspaceId}`;
  const previous = updateQueueByWorkspace.get(key) ?? Promise.resolve();
  let release = () => {};
  const queued = new Promise<void>((resolve) => { release = resolve; });
  const currentQueue = previous.then(() => queued, () => queued);
  updateQueueByWorkspace.set(key, currentQueue);
  await previous.catch(() => undefined);
  try { return await operation(); }
  finally {
    release();
    if (updateQueueByWorkspace.get(key) === currentQueue) updateQueueByWorkspace.delete(key);
  }
}

function parseSessionGroupState(stateJson: string): SessionGroupState {
  try {
    return normalizeSessionGroupState(JSON.parse(stateJson));
  } catch {
    return EMPTY_SESSION_GROUP_STATE;
  }
}

const sessionGroupStateStore = createWorkspaceKvStore<SessionGroupState>({
  tableName: "session_group_states",
  valueColumn: "state_json",
  extraColumns: { schemaVersion: { name: "schema_version", definition: "INTEGER NOT NULL DEFAULT 1", value: 2 } },
  parse: parseSessionGroupState,
  serialize: (value) => JSON.stringify(value),
});

export async function readSessionGroupState(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ state: SessionGroupState; updatedAt: number | null }> {
  const row = await sessionGroupStateStore.getRow(config, workspaceId);
  if (!row || row.updatedAt === null) return { state: EMPTY_SESSION_GROUP_STATE, updatedAt: null };
  if (hasLegacyProjectAssignments(row.valueJson)) {
    return queuedSessionGroupUpdate(config, workspaceId, async () => {
      const latest = await sessionGroupStateStore.getRow(config, workspaceId);
      if (!latest || latest.updatedAt === null) return { state: EMPTY_SESSION_GROUP_STATE, updatedAt: null };
      if (hasLegacyProjectAssignments(latest.valueJson)) return writeSessionGroupState(config, workspaceId, latest.value);
      return { state: latest.value, updatedAt: latest.updatedAt };
    });
  }
  return { state: row.value, updatedAt: row.updatedAt };
}

function hasLegacyProjectAssignments(json: string): boolean {
  try {
    const value = JSON.parse(json);
    return isRecord(value) && isRecord(value.assignments)
      && Object.values(value.assignments).some((id) => typeof id === "string" && id.startsWith("proj:"));
  } catch { return false; }
}

export async function writeSessionGroupState(
  config: ServerConfig,
  workspaceId: string,
  state: SessionGroupState,
): Promise<{ state: SessionGroupState; updatedAt: number }> {
  const next = normalizeSessionGroupState(state);
  const updatedAt = Date.now();
  await sessionGroupStateStore.set(config, workspaceId, next, updatedAt);
  return { state: next, updatedAt };
}

export async function updateSessionGroupState(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: SessionGroupState) => SessionGroupState,
): Promise<{ state: SessionGroupState; updatedAt: number }> {
  return queuedSessionGroupUpdate(config, workspaceId, async () => {
    const row = await sessionGroupStateStore.getRow(config, workspaceId);
    const state = row?.value ?? EMPTY_SESSION_GROUP_STATE;
    const next = updater(state);
    if (next === state && row?.updatedAt !== null && row?.updatedAt !== undefined && !hasLegacyProjectAssignments(row.valueJson)) {
      return { state, updatedAt: row.updatedAt };
    }
    return await writeSessionGroupState(config, workspaceId, next);
  });
}

/** Call only after the native session has been verified to belong to this company. */
export async function registerCreatedSessionGroup(
  config: ServerConfig,
  workspace: Pick<WorkspaceInfo, "id" | "path">,
  input: { sessionId: string; executionDirectory: string; parentSessionId?: string },
): Promise<{ state: SessionGroupState; updatedAt: number }> {
  if (!input.sessionId.trim() || input.sessionId.length > 256) throw new Error("Invalid created session ID");
  const [projects, executionDirectory] = await Promise.all([
    listCompanyProjects(workspace.path),
    isAbsolute(input.executionDirectory) ? realpath(input.executionDirectory).catch(() => null) : null,
  ]);
  const project = projects.find((entry) => entry.directory === executionDirectory);
  let initializedProject = false;
  let assignedGroup: string | undefined;
  let inheritedMeta = false;
  const result = await updateSessionGroupState(config, workspace.id, (stored) => {
    const current = synchronizeSessionProjectGroups(stored, projects);
    const parentGroup = input.parentSessionId ? current.assignments[input.parentSessionId] : undefined;
    const groupId = parentGroup && !parentGroup.startsWith("proj:") ? parentGroup : undefined;
    // Native events may be replayed after the person has already changed the group or role.
    if (!current.assignments[input.sessionId] && groupId) {
      current.assignments[input.sessionId] = groupId;
    }
    if (!Object.hasOwn(current.sessionMeta, input.sessionId) && input.parentSessionId
      && Object.hasOwn(current.sessionMeta, input.parentSessionId)) {
      const agentName = current.sessionMeta[input.parentSessionId]?.agentName;
      current.sessionMeta[input.sessionId] = agentName ? { agentName } : {};
      inheritedMeta = true;
    }
    if (!Object.hasOwn(current.sessionMeta[input.sessionId] ?? {}, "projectId")) {
      current.sessionMeta[input.sessionId] = { ...current.sessionMeta[input.sessionId], projectId: project?.id ?? null };
      initializedProject = true;
      assignedGroup = project?.id ?? groupId;
    }
    return JSON.stringify(current) === JSON.stringify(stored) ? stored : current;
  });
  const events = getSessionGroupEventStore(config);
  if (initializedProject) events.record(workspace.id, "assigned", { sessionId: input.sessionId, ...(assignedGroup ? { groupId: assignedGroup } : {}) });
  if (inheritedMeta) events.record(workspace.id, "meta", { sessionId: input.sessionId });
  return result;
}

/** Resolve once from legacy data/native creation; all subsequent calls use projectId exclusively. */
export async function resolveSessionProject(
  config: ServerConfig,
  workspace: Pick<WorkspaceInfo, "id" | "path">,
  sessionId: string,
  nativeDirectory?: string,
): Promise<SessionProject> {
  let { state } = await readSessionGroupState(config, workspace.id);
  if (!Object.hasOwn(state.sessionMeta[sessionId] ?? {}, "projectId")) {
    ({ state } = await registerCreatedSessionGroup(config, workspace, {
      sessionId, executionDirectory: nativeDirectory ?? workspace.path,
    }));
  }
  const projectId = state.sessionMeta[sessionId]?.projectId ?? null;
  if (projectId === null) return { projectId, executionDirectory: await realpath(workspace.path) };
  const project = (await listCompanyProjects(workspace.path)).find((entry) => entry.id === projectId);
  if (!project) throw new ApiError(404, "session_project_not_found", "会话所属项目目录不存在，请先移动到有效项目");
  return { projectId, executionDirectory: project.directory };
}

/** Backfill a batch only after each native session's company home has been verified. */
export async function resolveVerifiedSessionProjects(
  config: ServerConfig,
  workspace: Pick<WorkspaceInfo, "id" | "path">,
  sessions: ReadonlyArray<{ sessionId: string; nativeDirectory: string | null }>,
  projects: readonly CompanyProject[],
): Promise<Map<string, SessionProject>> {
  const valid = sessions.filter(({ sessionId }) => sessionId && sessionId.trim() === sessionId && sessionId.length <= 256);
  if (!valid.length) return new Map();
  const company = await realpath(workspace.path);
  const projectsById = new Map(projects.map(project => [project.id, project]));
  const projectsByDirectory = new Map(projects.map(project => [project.directory, project.id]));
  const directories = new Set<string>();
  if (projects.length) {
    for (const { nativeDirectory } of valid) {
      if (nativeDirectory && isAbsolute(nativeDirectory)) directories.add(nativeDirectory);
    }
  }
  const projectByNativeDirectory = new Map(await Promise.all([...directories].map(async directory => {
    const canonical = await realpath(directory).catch(() => null);
    return [directory, canonical ? projectsByDirectory.get(canonical) ?? null : null] as const;
  })));
  const initialized = new Map<string, SessionMetadata>();
  const { state } = await updateSessionGroupState(config, workspace.id, current => {
    for (const { sessionId, nativeDirectory } of valid) {
      const meta = Object.hasOwn(current.sessionMeta, sessionId) ? current.sessionMeta[sessionId] : undefined;
      if (!Object.hasOwn(meta ?? {}, "projectId")) {
        const projectId = nativeDirectory ? projectByNativeDirectory.get(nativeDirectory) ?? null : null;
        initialized.set(sessionId, { ...meta, projectId });
      }
    }
    if (!initialized.size) return current;
    return synchronizeSessionProjectGroups({
      ...current,
      sessionMeta: { ...current.sessionMeta, ...Object.fromEntries(initialized) },
    }, projects);
  });
  if (initialized.size) {
    const events = getSessionGroupEventStore(config);
    for (const [sessionId, { projectId }] of initialized) {
      events.record(workspace.id, "assigned", { sessionId, ...(projectId ? { groupId: projectId } : {}) });
    }
  }
  const resolved = new Map<string, SessionProject>();
  for (const { sessionId } of valid) {
    const projectId = state.sessionMeta[sessionId]?.projectId ?? null;
    const executionDirectory = projectId === null ? company : projectsById.get(projectId)?.directory;
    if (executionDirectory) resolved.set(sessionId, { projectId, executionDirectory });
  }
  return resolved;
}

export class SessionGroupEventStore {
  private eventsByWorkspace = new Map<string, SessionGroupEventState>();
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  record(
    workspaceId: string,
    action: SessionGroupEventAction,
    details?: { groupId?: string; sessionId?: string },
  ): SessionGroupEvent {
    const state = this.eventsByWorkspace.get(workspaceId) ?? { seq: 0, events: [] };
    const event: SessionGroupEvent = {
      id: shortId(),
      seq: ++state.seq,
      workspaceId,
      type: "session_groups.updated",
      action,
      ...(details?.groupId ? { groupId: details.groupId } : {}),
      ...(details?.sessionId ? { sessionId: details.sessionId } : {}),
      timestamp: Date.now(),
    };

    state.events.push(event);
    if (state.events.length > this.maxSize) {
      state.events.splice(0, state.events.length - this.maxSize);
    }
    this.eventsByWorkspace.set(workspaceId, state);
    return event;
  }

  list(workspaceId: string, since?: number): SessionGroupEvent[] {
    const cursor = typeof since === "number" && Number.isFinite(since) ? since : 0;
    const state = this.eventsByWorkspace.get(workspaceId);
    return state ? state.events.filter((event) => event.seq > cursor) : [];
  }

  cursor(workspaceId: string): number {
    return this.eventsByWorkspace.get(workspaceId)?.seq ?? 0;
  }
}

const eventStoresByRuntime = new Map<string, SessionGroupEventStore>();

export function getSessionGroupEventStore(config: ServerConfig): SessionGroupEventStore {
  const key = runtimeDbPath(config);
  let store = eventStoresByRuntime.get(key);
  if (!store) {
    store = new SessionGroupEventStore();
    eventStoresByRuntime.set(key, store);
  }
  return store;
}
