/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
if (typeof window === "undefined") GlobalRegistrator.register({ url: "http://localhost/" });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { ProjectsPage } = await import("../src/react-app/domains/aiopc/projects-page");
const { setLocale } = await import("../src/i18n");
const originalFetch = globalThis.fetch;
const originalBridge = window.__OPENWORK_ELECTRON__;
const project = { id: "proj:Alpha", name: "Alpha", path: "/company/projects/Alpha", description: "Test product", company: { name: "Company", path: "/company" }, brief: { context: "# Alpha\n\nTest product\n\n## 当前阶段与目标\n\nValidate retention\n\n## 已知事实\n\nA fact", brand: null, memory: null } };
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>; let client: QueryClient; let created = 0;
let onCreated: (value: typeof project) => Promise<void>; let opened: string[];
async function wait() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }
async function until(check: () => boolean) { for (let i = 0; i < 50 && !check(); i++) await wait(); expect(check()).toBe(true); }
function button(label: string) { const value = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === label); if (!value) throw new Error(label); return value; }
beforeEach(() => {
  setLocale("en"); created = 0; opened = []; onCreated = async () => {};
  window.localStorage.clear();
  Object.defineProperty(window, "__OPENWORK_ELECTRON__", { configurable: true, value: { aiopc: { connection: async () => ({ status: "ready", url: "http://localhost:9911", token: "test", error: "", home: "/home" }) } } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/projects") { expect(url.searchParams.get("workspace")).toBe("/company"); if (init?.method === "POST") { created++; return Response.json(project); } return Response.json({ company: project.company, projects: [project] }); }
    if (url.pathname === "/api/environments") return Response.json({ company: project.company, items: [], providers: [] });
    expect(url.searchParams.get("workspace")).toBe(project.path);
    if (url.pathname === "/api/project") return Response.json(project);
    if (url.pathname === "/api/space") return Response.json({ items: [{ path: `${project.path}/content/draft.md`, relative: "content/draft.md", name: "draft.md", section: "content", kind: "document", modified: 2, size: 3 }], truncated: false });
    throw new Error(url.pathname);
  }) as typeof fetch;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); document.body.innerHTML = ""; globalThis.fetch = originalFetch; });
afterAll(() => { Object.defineProperty(window, "__OPENWORK_ELECTRON__", { configurable: true, value: originalBridge }); });
async function render(projectName?: string) { await act(async () => root.render(<QueryClientProvider client={client}><ProjectsPage companyRoot="/company" projectName={projectName} onOpenProject={name => opened.push(name)} onCreated={value => onCreated(value as typeof project)} onStartConversation={() => {}} onOpenKnowledge={() => {}} /></QueryClientProvider>)); }

test("project overview reads its own files and presents only the recorded stage and real deliverables", async () => {
  await render("Alpha"); await until(() => host.textContent?.includes("Validate retention") === true);
  expect(host.textContent).toContain("draft.md");
  expect(host.textContent).not.toContain("A fact");
  expect(host.textContent).toContain("No environment bound");
});

test("project creation retries group synchronization without creating the project twice", async () => {
  let attempts = 0; onCreated = async () => { attempts++; if (attempts === 1) throw new Error("Group sync offline"); };
  await render(); await until(() => host.textContent?.includes("Test product") === true);
  await act(async () => button("New project").click());
  const input = document.querySelector('input[name="projectName"]') as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Alpha"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => button("Create project").click()); await until(() => document.body.textContent?.includes("Group sync offline") === true);
  expect(opened).toEqual([]); expect(created).toBe(1);
  await act(async () => button("Retry").click()); await until(() => opened.length === 1);
  expect(created).toBe(1); expect(attempts).toBe(2); expect(opened).toEqual(["Alpha"]);
});
