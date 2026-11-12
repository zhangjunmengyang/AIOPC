/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
if (typeof window === "undefined")
  GlobalRegistrator.register({
    url: "http://localhost/",
    settings: { enableIframePageLoading: true },
  });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { EnvironmentView } =
  await import("../src/react-app/domains/aiopc/environment-view");
const { setLocale } = await import("../src/i18n");
const oldFetch = globalThis.fetch,
  oldBridge = window.__OPENWORK_ELECTRON__;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let actions: any[];
let holder: any;
let queued: boolean;
let duration: number;
let denied: boolean;
const automation = {
  ownerKey: "automation:worker",
  kind: "automation",
  sessionId: "worker",
  label: "Writer",
  expiresAt: Date.now() + 60000,
  waitingForUser: false,
};
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300 && !predicate(); i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  expect(predicate()).toBe(true);
}
function button(name: string) {
  const found = [...document.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === name,
  );
  if (!found) throw new Error(name);
  return found;
}
beforeEach(() => {
  setLocale("en");
  actions = [];
  holder = automation;
  queued = false;
  duration = 60000;
  denied = false;
  Object.defineProperty(window, "__OPENWORK_ELECTRON__", {
    configurable: true,
    value: {
      aiopc: {
        connection: async () => ({
          status: "ready",
          url: "http://localhost:9996",
          token: "fixture",
          home: "/home",
          error: "",
        }),
      },
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.searchParams.get("workspace")).toBe("/company/projects/A");
    expect(url.searchParams.get("environment")).toBe("env-A");
    if (url.pathname === "/api/environment")
      return Response.json({
        id: "env-A",
        running: true,
        live_view_url: "about:blank",
      });
    if (denied && url.pathname === "/api/environment/lease")
      return Response.json(
        { error: "Environment is no longer bound to this project" },
        { status: 409 },
      );
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      actions.push(body);
      if (body.action === "acquire") {
        if (queued)
          return Response.json({
            state: "queued",
            requestId: "request-1",
            position: 1,
            holder,
          });
        holder = {
          ownerKey: "human:" + body.sessionId,
          sessionId: body.sessionId,
          kind: "human",
          label: "You",
          expiresAt: Date.now() + duration,
          waitingForUser: false,
        };
        return Response.json({
          state: "granted",
          leaseId: "lease-private",
          holder,
          expiresAt: holder.expiresAt,
        });
      }
      if (body.action === "release" || body.action === "cancel") holder = null;
      if (body.action === "heartbeat")
        holder = { ...holder, expiresAt: Date.now() + 60000 };
    }
    return Response.json({
      holder,
      queue: queued
        ? [{ requestId: "request-1", kind: "human", label: "You", position: 1 }]
        : [],
      bindingRevision: 4,
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
        <EnvironmentView
          workspaceRoot="/company/projects/A"
          environmentId="env-A"
        />
      </QueryClientProvider>,
    ),
  );
  await until(() => host.querySelector("iframe") !== null);
}

test("watch is inert; explicit manual lease enables input, renewal and return are intentional", async () => {
  await render();
  const frame = host.querySelector("iframe")!;
  expect(frame.hasAttribute("inert")).toBe(true);
  expect(frame.tabIndex).toBe(-1);
  expect(actions).toEqual([]);
  expect(host.textContent).toContain("Writer");
  await act(async () => button("Take control").click());
  await until(() => !frame.hasAttribute("inert"));
  expect(actions[0]).toMatchObject({
    action: "acquire",
    manual: true,
    bindingRevision: 4,
  });
  expect(frame.src).not.toContain("lease-private");
  await act(async () => button("Continue control").click());
  await until(() => actions.length === 2);
  expect(actions[1]).toMatchObject({
    action: "heartbeat",
    activity: true,
    leaseId: "lease-private",
  });
  await act(async () => button("Return control").click());
  await until(() => frame.hasAttribute("inert"));
  expect(actions.at(-1).action).toBe("release");
});
test("queued control remains inert and can be cancelled without giving input access", async () => {
  queued = true;
  await render();
  await act(async () => button("Take control").click());
  await until(() => host.textContent?.includes("Queue position: 1") === true);
  expect(host.querySelector("iframe")!.hasAttribute("inert")).toBe(true);
  await act(async () => button("Cancel request").click());
  await until(() => actions.at(-1)?.action === "cancel");
  expect(actions.at(-1).requestId).toBe("request-1");
});
test("an expired manual lease closes input without automatic renewal", async () => {
  duration = 100;
  await render();
  await act(async () => button("Take control").click());
  await until(() => actions.length === 1);
  await until(() => !host.querySelector("iframe")!.hasAttribute("inert"));
  await until(() => host.querySelector("iframe")!.hasAttribute("inert"));
  expect(actions.some((action) => action.action === "heartbeat")).toBe(false);
});

test("a revoked binding closes the viewer rather than exposing the other project", async () => {
  await render();
  denied = true;
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ["aiopc", "/company/projects/A", "environment-lease", "env-A"],
    });
  });
  await until(
    () =>
      host.textContent?.includes(
        "Environment is no longer bound to this project",
      ) === true,
  );
  expect(host.querySelector("iframe")).toBeNull();
});

test("a queued viewer keeps its request id when it receives control", async () => {
  queued = true;
  await render();
  await act(async () => button("Take control").click());
  await until(() => host.textContent?.includes("Queue position: 1") === true);
  queued = false;
  await until(() => !host.querySelector("iframe")!.hasAttribute("inert"));
  expect(actions[1]).toMatchObject({
    action: "acquire",
    requestId: "request-1",
  });
});
