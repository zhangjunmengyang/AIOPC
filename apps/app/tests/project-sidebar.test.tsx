/** @jsxImportSource react */
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { SidebarContextValue } from "../src/react-app/domains/session/sidebar/app-sidebar-provider";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { GroupedSessionList, SidebarReorderScope } = await import("../src/react-app/domains/session/sidebar/app-sidebar");
const { SidebarContext } = await import("../src/react-app/domains/session/sidebar/app-sidebar-provider");
const { useSessionManagementStore, setSessionGroupSyncHandler } = await import("../src/react-app/domains/session/sidebar/session-management-store");
const { setLocale } = await import("../src/i18n");
const { SessionDragScope, useDraggedSession, SESSION_DRAG_TYPE } = await import("../src/react-app/domains/session/sidebar/session-reorder");
let root: Root | null = null;
let host: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); root = null; host?.remove(); setSessionGroupSyncHandler(null); });
afterAll(async () => { Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct); if (ownedDom) await GlobalRegistrator.unregister(); });

test("project folders keep their identity while their plus button targets that project", async () => {
  setLocale("en");
  const calls: unknown[][] = [];
  const groups = [{ id: "proj:Alpha", label: "Alpha" }, { id: "grp_notes", label: "Notes" }];
  useSessionManagementStore.setState({ groupsByWorkspace: { company: { groups, assignments: {}, sessionMeta: {} } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const context = { selectedWorkspaceId: "company", selectedSessionId: null, developerMode: false,
    newTaskDisabled: false, workspaceConnectionStateById: {}, expandedWorkspaceIds: new Set(["company"]),
    onCreateTaskInWorkspace: (...args: unknown[]) => calls.push(args),
  } as unknown as SidebarContextValue;
  await act(async () => root?.render(<SidebarContext.Provider value={context}>
    <SidebarReorderScope><GroupedSessionList sessionRows={[]} groups={groups} assignments={{}} pinnedIds={new Set()} workspaceId="company" store={useSessionManagementStore} /></SidebarReorderScope>
  </SidebarContext.Provider>));
  expect(host.textContent).toContain("Company conversations");
  const project = host.querySelector('[data-session-group="proj:Alpha"]')!;
  await act(async () => (project.querySelector('button[aria-label="Group actions"]') as HTMLButtonElement).focus());
  expect(project.querySelector('button[aria-label="Rename Group"]')).toBeNull();
  expect(project.querySelector('button[aria-label="Delete Group"]')).toBeNull();
  await act(async () => (project.querySelector('button[aria-label="New session in group"]') as HTMLButtonElement).click());
  expect(calls).toEqual([["company", "proj:Alpha"]]);
  const ordinary = host.querySelector('[data-session-group="grp_notes"]')!;
  await act(async () => (ordinary.querySelector('button[aria-label="Group actions"]') as HTMLButtonElement).focus());
  expect(ordinary.querySelector('button[aria-label="Rename Group"]')).not.toBeNull();
});

test("a project title opens its overview while its separate arrow only collapses the group", async () => {
  setLocale("en");
  const opened: unknown[][] = [];
  const groups = [{ id: "proj:Alpha", label: "Alpha" }];
  useSessionManagementStore.setState({ groupsByWorkspace: { company: { groups, assignments: {}, sessionMeta: {} } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const context = { selectedWorkspaceId: "company", selectedSessionId: null, developerMode: false,
    newTaskDisabled: false, workspaceConnectionStateById: {}, expandedWorkspaceIds: new Set(["company"]),
    onOpenProject: (...args: unknown[]) => opened.push(args), onCreateTaskInWorkspace: () => {},
  } as unknown as SidebarContextValue;
  await act(async () => root?.render(<SidebarContext.Provider value={context}>
    <SidebarReorderScope><GroupedSessionList sessionRows={[]} groups={groups} assignments={{}} pinnedIds={new Set()} workspaceId="company" store={useSessionManagementStore} /></SidebarReorderScope>
  </SidebarContext.Provider>));
  const title = host.querySelector('button[data-project-title="proj:Alpha"]') as HTMLButtonElement;
  expect(title).not.toBeNull();
  await act(async () => title.click());
  expect(opened).toEqual([["company", "Alpha"]]);
  expect(useSessionManagementStore.getState().groupsByWorkspace.company?.collapsedGroupIds ?? []).toEqual([]);
  const arrow = host.querySelector('button[aria-label="Collapse Alpha"]') as HTMLButtonElement;
  expect(arrow).not.toBeNull();
  await act(async () => arrow.click());
  expect(useSessionManagementStore.getState().groupsByWorkspace.company?.collapsedGroupIds).toEqual(["proj:Alpha"]);
  expect(opened).toHaveLength(1);
});

for (const [status, attention, allowed] of [["idle", undefined, false], ["busy", undefined, false], ["waiting", "permission", false]] as const) {
  test(`project drop follows the same move guard (${status}, ${attention ?? "none"})`, async () => {
    const calls: unknown[] = [];
    const groups = [{ id: "proj:A", label: "A" }, { id: "proj:B", label: "B" }];
    const state = { groups, assignments: { session: "proj:A" }, sessionMeta: { session: { projectId: "proj:A" } } };
    useSessionManagementStore.setState({ groupsByWorkspace: { company: state } });
    setSessionGroupSyncHandler({ assignGroup: async (...args: unknown[]) => { calls.push(args); return { ...state, sessionMeta: { session: { projectId: "proj:B" } } }; } } as Parameters<typeof setSessionGroupSyncHandler>[0]);
    function StartDrag() { const drag = useDraggedSession(); return <button onClick={() => drag.setSession({ id: "session", workspaceId: "company" })}>Start drag</button>; }
    const context = { selectedWorkspaceId: "company", selectedSessionId: null, developerMode: false, newTaskDisabled: false,
      workspaceConnectionStateById: {}, expandedWorkspaceIds: new Set(["company"]), sessionStatusById: { session: status }, sessionAttentionKindById: { session: attention },
      onOpenProject: () => {}, onCreateTaskInWorkspace: () => {},
    } as unknown as SidebarContextValue;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root?.render(<SidebarContext.Provider value={context}><SidebarReorderScope><SessionDragScope><StartDrag /><GroupedSessionList sessionRows={[]} groups={groups} assignments={state.assignments} pinnedIds={new Set()} workspaceId="company" store={useSessionManagementStore} /></SessionDragScope></SidebarReorderScope></SidebarContext.Provider>));
    await act(async () => (Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Start drag")!).click());
    const target = host.querySelector('[data-session-group="proj:B"]')!;
    const event = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: [SESSION_DRAG_TYPE], getData: () => "session" } });
    await act(async () => { target.dispatchEvent(event); });
    expect(calls).toEqual(allowed ? [["company", "session", "proj:B"]] : []);
    expect(useSessionManagementStore.getState().groupsByWorkspace.company?.sessionMeta?.session.projectId).toBe(allowed ? "proj:B" : "proj:A");
  });
}
