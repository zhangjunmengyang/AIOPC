/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
if (typeof window === "undefined") GlobalRegistrator.register({ url: "http://localhost/" });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { useSessionAgentSelection, useSessionAgentStore } = await import("../src/react-app/domains/session/surface/session-mode-memory");
const { useSessionManagementStore, setSessionGroupSyncHandler } = await import("../src/react-app/domains/session/sidebar/session-management-store");
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
function Picker({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  const selection = useSessionAgentSelection({ workspaceId, sessionId, fallbackAgent: "draft-role", onFallbackAgentChange: () => {} });
  return <div><output>{selection.selectedAgent ?? "Default"}</output><button onClick={() => selection.setAgent(null)}>Clear</button></div>;
}
beforeEach(() => {
  window.localStorage.clear();
  useSessionManagementStore.setState({ groupsByWorkspace: {}, serverSyncedWorkspaces: {} });
  useSessionAgentStore.setState({ bySessionId: { one: "old-local-role", two: "old-local-role" } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setSessionGroupSyncHandler(null); });
afterAll(() => { Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });

test("the role picker restores server state after reload and never revives a cleared role from browser cache", async () => {
  await act(async () => root.render(<Picker workspaceId="company-a" sessionId="one" />));
  expect(host.querySelector("output")?.textContent).toBe("old-local-role");
  await act(async () => useSessionManagementStore.getState().replaceWorkspaceGroups("company-a", { groups: [], assignments: {}, sessionMeta: { one: { agentName: "writer" } } }));
  expect(host.querySelector("output")?.textContent).toBe("writer");
  await act(async () => useSessionManagementStore.getState().replaceWorkspaceGroups("company-a", { groups: [], assignments: {}, sessionMeta: { one: {} } }));
  await act(async () => useSessionAgentStore.setState({ bySessionId: { one: "old-local-role" } }));
  expect(host.querySelector("output")?.textContent).toBe("Default");
  await act(async () => {
    useSessionManagementStore.getState().replaceWorkspaceGroups("company-b", { groups: [], assignments: {}, sessionMeta: { two: { agentName: "writer" } } });
    root.render(<Picker workspaceId="company-b" sessionId="two" />);
  });
  expect(host.querySelector("output")?.textContent).toBe("writer");
  await act(async () => useSessionManagementStore.getState().replaceWorkspaceGroups("company-b", { groups: [], assignments: {}, sessionMeta: {} }));
  expect(host.querySelector("output")?.textContent).toBe("Default");
});

test("the role picker only shows a clear after the server acknowledges persistence", async () => {
  useSessionManagementStore.getState().replaceWorkspaceGroups("company-a", { groups: [], assignments: {}, sessionMeta: { one: { agentName: "writer" } } });
  let acknowledge: (() => void) | undefined;
  setSessionGroupSyncHandler({ setSessionAgent: async (workspaceId, sessionId, name) => {
    expect([workspaceId, sessionId, name]).toEqual(["company-a", "one", null]);
    await new Promise<void>(resolve => { acknowledge = resolve; });
    return { groups: [], assignments: {}, sessionMeta: { one: {} } };
  } } as Parameters<typeof setSessionGroupSyncHandler>[0]);
  await act(async () => root.render(<Picker workspaceId="company-a" sessionId="one" />));
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector("output")?.textContent).toBe("writer");
  await act(async () => acknowledge?.());
  expect(host.querySelector("output")?.textContent).toBe("Default");
});
