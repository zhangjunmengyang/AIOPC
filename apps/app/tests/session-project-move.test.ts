import { afterAll, beforeEach, expect, test } from "bun:test";
import { sessionProjectContext } from "../src/react-app/domains/aiopc/company-project";


const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const { useSessionManagementStore: store, setSessionGroupSyncHandler } = await import("../src/react-app/domains/session/sidebar/session-management-store");
afterAll(() => { setSessionGroupSyncHandler(null); if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); });
const initial = () => ({ groups: [{ id: "proj:A", label: "A" }, { id: "proj:B", label: "B" }], assignments: { session: "proj:A" }, sessionMeta: { session: { projectId: "proj:A", agentName: "writer" } } });
beforeEach(() => { setSessionGroupSyncHandler(null); store.setState({ groupsByWorkspace: { company: initial() } }); });

test("projectId alone determines current execution context even if an old engine snapshot still names the source", () => {
  const session = { directory: "/company", executionDirectory: "/company/projects/A", projectId: "proj:A" };
  expect(sessionProjectContext("/company", session, { projectId: "proj:B" })).toEqual({ projectId: "proj:B", executionDirectory: "/company/projects/B" });
  expect(sessionProjectContext("/company", session, { projectId: null })).toEqual({ projectId: null, executionDirectory: "/company" });
  expect(sessionProjectContext("/tmp/company", { ...session, directory: "/private/tmp/company", projectId: "proj:B" })).toEqual({ projectId: "proj:B", executionDirectory: "/private/tmp/company/projects/B" });
});

test("a created session cannot be moved between projects or back to the company", async () => {
  const calls: unknown[] = [];
  setSessionGroupSyncHandler({ assignGroup: async (...args: unknown[]) => { calls.push(args); return initial(); } } as Parameters<typeof setSessionGroupSyncHandler>[0]);
  for (const destination of ["proj:B", null]) await expect(store.getState().assignGroup("company", "session", destination)).rejects.toThrow("new conversation");
  expect(calls).toEqual([]);
  expect(store.getState().groupsByWorkspace.company).toEqual(initial());
});

test("company conversations can be organized in custom display groups without changing projectId", async () => {
  const state = { groups: [...initial().groups, { id: "notes", label: "Notes" }], assignments: {}, sessionMeta: { session: { projectId: null, agentName: "writer" } } };
  store.setState({ groupsByWorkspace: { company: state } });
  const calls: unknown[] = [];
  setSessionGroupSyncHandler({ assignGroup: async (...args: unknown[]) => { calls.push(args); return { ...state, assignments: { session: "notes" } }; } } as Parameters<typeof setSessionGroupSyncHandler>[0]);
  await expect(store.getState().assignGroup("company", "session", "proj:A")).rejects.toThrow("new conversation");
  await store.getState().assignGroup("company", "session", "notes");
  expect(calls).toEqual([["company", "session", "notes"]]);
  expect(store.getState().groupsByWorkspace.company?.sessionMeta?.session).toEqual({ projectId: null, agentName: "writer" });
  expect(store.getState().groupsByWorkspace.company?.assignments.session).toBe("notes");
});
