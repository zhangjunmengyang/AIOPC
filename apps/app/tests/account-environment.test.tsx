/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, test, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
if (typeof window === "undefined")
  GlobalRegistrator.register({ url: "http://localhost/" });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
mock.module("../src/react-app/domains/aiopc/platform-icon", () => ({
  PlatformIcon: () => null,
}));
const { createRoot } = await import("react-dom/client");
const { AccountsPage } =
  await import("../src/react-app/domains/aiopc/accounts-page");
const { setLocale } = await import("../src/i18n");
const { writeActiveWorkspaceId } =
  await import("../src/react-app/shell/session-memory");
const { consumePendingChatSeed } =
  await import("../src/react-app/domains/session/chat/pending-chat-seed");
const { PlatformProvider, createDefaultPlatform } =
  await import("../src/react-app/kernel/platform");
const oldFetch = globalThis.fetch,
  oldBridge = window.__OPENWORK_ELECTRON__;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let checks: URL[];
let location = "";
const project = {
  id: "proj:Product",
  name: "Product",
  path: "/company/projects/Product",
  company: { name: "Company", path: "/company" },
};
const account = {
  account_id: "account-A",
  environment: "env-A",
  platform: "demo",
  platform_name: "Demo",
  name: "Existing account",
  handle: "",
  url: "",
  status: "ready",
  publish: "browser",
  forms: [],
  reads: [],
  routes: [],
  enhancements: [],
  services: [],
};
const resources = ["A", "B"].map((id) => ({
  id: "env-" + id,
  name: "Account " + id,
  company: "/company",
  boundProject: project.path,
  lastProject: project.path,
  bindingRevision: 1,
  provider: "local",
  status: "stopped",
  running: false,
  live_view_url: "",
  cdp_url: "",
  detail: "",
}));
function Location() {
  const value = useLocation();
  location = value.pathname + value.search;
  return null;
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 50 && !predicate(); i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  expect(predicate()).toBe(true);
}
function button(text: string) {
  const b = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!b) throw new Error(text);
  return b;
}
beforeEach(() => {
  setLocale("en");
  checks = [];
  consumePendingChatSeed();
  writeActiveWorkspaceId("company");
  Object.defineProperty(window, "__OPENWORK_ELECTRON__", {
    configurable: true,
    value: {
      aiopc: {
        connection: async () => ({
          status: "ready",
          url: "http://localhost:9997",
          token: "fixture",
          home: "/home",
          error: "",
        }),
      },
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/project") return Response.json(project);
    if (url.pathname === "/api/environments")
      return Response.json({
        company: project.company,
        items: resources,
        providers: [],
      });
    if (url.pathname === "/api/platforms")
      return Response.json({
        platforms: [
          {
            id: "demo",
            name: "Demo",
            region: "cn",
            category_name: "Demo",
            region_name: "Local",
            forms: [],
            methods: [],
            login_url: "https://example.test",
          },
        ],
      });
    if (url.pathname === "/api/accounts") {
      expect(url.searchParams.has("environment")).toBe(false);
      return Response.json({ accounts: [account] });
    }
    if (url.pathname === "/api/history") return Response.json({ items: [] });
    if (url.pathname === "/api/accounts/connect") {
      checks.push(url);
      return Response.json({ status: "connected", account });
    }
    throw new Error(url.pathname);
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  document.body.innerHTML = "";
  globalThis.fetch = oldFetch;
});
afterAll(() =>
  Object.defineProperty(window, "__OPENWORK_ELECTRON__", {
    configurable: true,
    value: oldBridge,
  }),
);
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PlatformProvider value={createDefaultPlatform()}>
          <MemoryRouter>
            <AccountsPage workspaceRoot={project.path} />
            <Location />
          </MemoryRouter>
        </PlatformProvider>
      </QueryClientProvider>,
    ),
  );
  await until(() => host.textContent?.includes("Existing account") === true);
}

test("new login requires an explicit environment when several are bound, and keeps the project draft", async () => {
  await render();
  await until(
    () =>
      document.querySelector('select[aria-label="Login environment"]') !== null,
  );
  expect(button("Connect account").disabled).toBe(true);
  const select = document.querySelector(
    'select[aria-label="Login environment"]',
  ) as HTMLSelectElement;
  await until(() => select.querySelector('option[value="env-B"]') !== null);
  await act(async () => {
    select.value = "env-B";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Connect account").click());
  await until(() =>
    [...document.querySelectorAll("button")].some(
      (item) => item.textContent?.trim() === "Demo",
    ),
  );
  await act(async () => button("Demo").click());
  expect(consumePendingChatSeed()).toContain("env-B");
  expect(location).toContain("draftGroup=proj%3AProduct");
});
test("checking an existing account uses its own environment, not the newly selected login environment", async () => {
  await render();
  const select = document.querySelector(
    'select[aria-label="Login environment"]',
  ) as HTMLSelectElement;
  await until(() => select.querySelector('option[value="env-B"]') !== null);
  await act(async () => {
    select.value = "env-B";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[role="listitem"]')!.click(),
  );
  await act(async () => button("Check login").click());
  await until(() => checks.length === 1);
  expect(checks[0]!.searchParams.get("environment")).toBe("env-A");
});
