/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
if (typeof window === "undefined")
  GlobalRegistrator.register({ url: "http://localhost/" });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { ProjectEnvironments, EnvironmentPoolView } =
  await import("../src/react-app/domains/aiopc/environment-pool");
const { PlatformProvider, createDefaultPlatform } =
  await import("../src/react-app/kernel/platform");
const { setLocale } = await import("../src/i18n");
const oldFetch = globalThis.fetch,
  oldBridge = window.__OPENWORK_ELECTRON__;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let requests: any[];
let entries: any[];
let localAvailable: boolean;
const env = (
  id: string,
  boundProject: string | null,
  lastProject = boundProject,
) => ({
  id,
  name: id,
  company: "/company",
  provider: "local",
  boundProject,
  lastProject,
  bindingRevision: 1,
  status: "stopped",
  running: false,
  cdp_url: "",
  live_view_url: "",
  detail: "",
});
async function until(predicate: () => boolean) {
  for (let i = 0; i < 50 && !predicate(); i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  expect(predicate()).toBe(true);
}
function button(label: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!found) throw new Error(label);
  return found;
}
beforeEach(() => {
  setLocale("en");
  requests = [];
  localAvailable = true;
  entries = [
    env("Account A", "/company/projects/Target"),
    env("Account B", "/company/projects/Target"),
    env("Spare", null, "/company/projects/Old"),
  ];
  Object.defineProperty(window, "__OPENWORK_ELECTRON__", {
    configurable: true,
    value: {
      aiopc: {
        connection: async () => ({
          status: "ready",
          url: "http://localhost:9998",
          token: "fixture",
          home: "/home",
          error: "",
        }),
      },
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.searchParams.get("workspace")).toBe("/company");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      if (body.action === "install-engine") {
        localAvailable = true;
        return Response.json({ installed: true });
      }
      if (
        body.action === "bind" &&
        !body.confirmation &&
        entries[2].lastProject !== body.project
      )
        return Response.json(
          {
            error: "Confirmation required",
            requires_confirmation: true,
            affectedAccounts: [
              {
                account_id: "old",
                name: "Old brand account",
                platform_name: "X",
              },
            ],
            confirmation: "bind-confirmation",
          },
          { status: 409 },
        );
      entries = entries.map((item) =>
        item.id === "Spare"
          ? { ...item, boundProject: "/company/projects/Target" }
          : item,
      );
      return Response.json(entries[2]);
    }
    if (url.pathname === "/api/projects")
      return Response.json({
        company: { name: "Company", path: "/company" },
        projects: [],
      });
    return Response.json({
      company: { name: "Company", path: "/company" },
      items: entries,
      providers: [
        {
          id: "local",
          name: "Local Docker",
          kind: "local",
          summary: "",
          help_url: "",
          persists_logins: true,
          configured: true,
          available: localAvailable,
          detail: "",
          fields: [],
        },
      ],
    });
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
        <ProjectEnvironments
          companyRoot="/company"
          projectRoot="/company/projects/Target"
        />
      </QueryClientProvider>,
    ),
  );
}

test("one project shows both bound environments without replacing either", async () => {
  await render();
  await until(() => host.textContent?.includes("Account B") === true);
  expect(host.textContent).toContain("Account A");
  expect(host.querySelectorAll("[data-environment-id]")).toHaveLength(2);
  expect(requests).toEqual([]);
});
test("cross-project reuse waits for explicit confirmation and lists affected accounts", async () => {
  await render();
  await until(() => host.textContent?.includes("Account B") === true);
  await act(async () => button("Add environment").click());
  await until(
    () => document.querySelector('[data-environment-id="Spare"]') !== null,
  );
  await act(async () =>
    button(
      "Bind to this project",
      document.querySelector('[data-environment-id="Spare"]')!,
    ).click(),
  );
  await until(
    () => document.body.textContent?.includes("Old brand account") === true,
  );
  expect(requests).toHaveLength(1);
  expect(entries[2].boundProject).toBeNull();
  await act(async () => button("Clear login data and bind").click());
  await until(() => requests.length === 2);
  expect(requests[1]).toEqual({
    action: "bind",
    project: "/company/projects/Target",
    confirmation: "bind-confirmation",
  });
  await until(
    () => host.querySelectorAll("[data-environment-id]").length === 3,
  );
});

test("rebinding to the same project needs no wipe confirmation", async () => {
  entries[2].lastProject = "/company/projects/Target";
  await render();
  await until(() => host.textContent?.includes("Account B") === true);
  await act(async () => button("Add environment").click());
  await until(
    () => document.querySelector('[data-environment-id="Spare"]') !== null,
  );
  await act(async () =>
    button(
      "Bind to this project",
      document.querySelector('[data-environment-id="Spare"]')!,
    ).click(),
  );
  await until(() => requests.length === 1);
  await until(
    () => host.querySelectorAll("[data-environment-id]").length === 3,
  );
  expect(requests[0]).toEqual({
    action: "bind",
    project: "/company/projects/Target",
  });
  expect(document.body.textContent).not.toContain("Clear login data and bind");
});

test("a missing local engine keeps its installation entry in the resource pool", async () => {
  localAvailable = false;
  entries = [];
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PlatformProvider value={createDefaultPlatform()}>
          <EnvironmentPoolView companyRoot="/company" />
        </PlatformProvider>
      </QueryClientProvider>,
    ),
  );
  await until(() => host.textContent?.includes("Install for me") === true);
  await act(async () => button("Install for me").click());
  await until(() => requests.length === 1);
  expect(requests[0]).toEqual({ action: "install-engine" });
});

test("new environment form exposes a stable provider label independent of its options", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PlatformProvider value={createDefaultPlatform()}>
          <EnvironmentPoolView companyRoot="/company" />
        </PlatformProvider>
      </QueryClientProvider>,
    ),
  );
  await until(() => host.textContent?.includes("Account A") === true);
  await act(async () => button("Create environment").click());
  const provider = document.querySelector<HTMLSelectElement>(
    'select[aria-label="Provider"]',
  );
  expect(provider).not.toBeNull();
  expect(provider?.selectedOptions[0]?.textContent).toBe("Local Docker");
  expect(
    document.querySelector('input[name="environmentName"]'),
  ).not.toBeNull();
});

test("a bound resource keeps its project label while the project catalog is missing", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <EnvironmentPoolView companyRoot="/company" />
      </QueryClientProvider>,
    ),
  );
  await until(
    () =>
      host.querySelector('select[aria-label="Project for Account A"]') !== null,
  );
  const select = host.querySelector<HTMLSelectElement>(
    'select[aria-label="Project for Account A"]',
  )!;
  expect(select.value).toBe("/company/projects/Target");
  expect(select.selectedOptions[0]?.textContent).toBe("Target");
});
