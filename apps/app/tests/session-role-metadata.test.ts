import { afterAll, beforeEach, expect, test } from "bun:test";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const stored = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
  removeItem: (key: string) => { stored.delete(key); },
} });
const { useSessionManagementStore, setSessionGroupSyncHandler, createProjectSessionGroup, refreshSessionGroupState } = await import("../src/react-app/domains/session/sidebar/session-management-store");
const { getSessionAgentSelection, useSessionAgentStore } = await import("../src/react-app/domains/session/surface/session-mode-memory");
afterAll(() => {
  setSessionGroupSyncHandler(null);
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const workspaceId = "company";
beforeEach(() => {
  setSessionGroupSyncHandler(null);
  useSessionManagementStore.setState({ groupsByWorkspace: { [workspaceId]: {
    groups: [{ id: "proj:A", label: "A" }], assignments: { session: "proj:A" }, sessionMeta: { session: { agentName: "designer" } },
  } } });
  useSessionAgentStore.setState({ bySessionId: { session: "stale-local-role" } });
});

test("server role metadata overrides a stale browser cache and an explicit cleared role stays cleared", () => {
  expect(getSessionAgentSelection("session", "fallback", workspaceId)).toBe("designer");
  const state = useSessionManagementStore.getState().groupsByWorkspace[workspaceId]!;
  useSessionManagementStore.getState().replaceWorkspaceGroups(workspaceId, { ...state, sessionMeta: { session: {} } });
  expect(getSessionAgentSelection("session", "fallback", workspaceId)).toBeNull();
});

test("role updates wait for server persistence and consume the authoritative group snapshot", async () => {
  const requests: unknown[][] = [];
  setSessionGroupSyncHandler({
    setSessionAgent: async (workspace, sessionId, agentName) => {
      requests.push([workspace, sessionId, agentName]);
      const state = useSessionManagementStore.getState().groupsByWorkspace[workspaceId]!;
      return { ...state, sessionMeta: { ...state.sessionMeta, [sessionId]: agentName ? { agentName } : {} } };
    },
  } as Parameters<typeof setSessionGroupSyncHandler>[0]);
  await useSessionManagementStore.getState().setSessionAgent(workspaceId, "session", "growth");
  expect(requests).toEqual([[workspaceId, "session", "growth"]]);
  expect(getSessionAgentSelection("session", null, workspaceId)).toBe("growth");
  await useSessionManagementStore.getState().setSessionAgent(workspaceId, "session", null);
  expect(getSessionAgentSelection("session", "fallback", workspaceId)).toBeNull();
});

test("a failed role write does not pretend the new binding was persisted", async () => {
  setSessionGroupSyncHandler({ setSessionAgent: async () => { throw new Error("offline"); } } as Parameters<typeof setSessionGroupSyncHandler>[0]);
  await expect(useSessionManagementStore.getState().setSessionAgent(workspaceId, "session", "growth")).rejects.toThrow("offline");
  expect(getSessionAgentSelection("session", null, workspaceId)).toBe("designer");
});

test("loaded server state with no binding never resurrects a stale local role", () => {
  useSessionAgentStore.setState({ bySessionId: { session: "old-role", other: "old-role" } });
  useSessionManagementStore.getState().replaceWorkspaceGroups("company", { groups: [], assignments: {}, sessionMeta: {} });
  useSessionManagementStore.getState().replaceWorkspaceGroups("other-company", { groups: [], assignments: {}, sessionMeta: { other: { agentName: "designer" } } });
  expect(getSessionAgentSelection("session", "fallback", "company")).toBeNull();
  expect(getSessionAgentSelection("other", "fallback", "company")).toBeNull();
  expect(getSessionAgentSelection("other", "fallback", "other-company")).toBe("designer");
  useSessionManagementStore.getState().replaceWorkspaceGroups("other-company", { groups: [], assignments: {}, sessionMeta: { other: {} } });
  useSessionAgentStore.setState({ bySessionId: { other: "old-role" } });
  expect(getSessionAgentSelection("other", "fallback", "other-company")).toBeNull();
});

test("creating a project synchronizes its stable group and preserves server role metadata", async () => {
  const groups: unknown[] = [];
  setSessionGroupSyncHandler({ createGroup: async (_workspace, group) => {
    groups.push(group); return { groups: [group], assignments: {}, sessionMeta: { session: { agentName: "writer" } } };
  } } as Parameters<typeof setSessionGroupSyncHandler>[0]);
  await createProjectSessionGroup("company", "Alpha");
  expect(groups).toEqual([{ id: "proj:Alpha", label: "Alpha" }]);
  expect(useSessionManagementStore.getState().groupsByWorkspace.company?.groups).toEqual(groups as never);
  expect(getSessionAgentSelection("session", null, "company")).toBe("writer");
});

test("forks consume the server project and role without copying stale source metadata back", async () => {
  const calls: string[] = [];
  setSessionGroupSyncHandler({
    getGroups: async (workspace) => {
      calls.push(workspace);
      return { groups: [{ id: "proj:B", label: "B" }], assignments: { fork: "proj:B" }, sessionMeta: { fork: { agentName: "writer" } } };
    },
    assignGroup: async () => { throw new Error("must not overwrite server assignment"); },
    setSessionAgent: async () => { throw new Error("must not overwrite server role"); },
  } as Parameters<typeof setSessionGroupSyncHandler>[0]);
  await refreshSessionGroupState("company");
  expect(calls).toEqual(["company"]);
  expect(getSessionAgentSelection("fork", null, "company")).toBe("writer");
  expect(useSessionManagementStore.getState().groupsByWorkspace.company?.assignments.fork).toBe("proj:B");
});
