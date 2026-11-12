/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

if (typeof window === "undefined") {
  GlobalRegistrator.register({ url: "http://localhost/", settings: { enableIframePageLoading: true } });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { useEnvironmentLease } = await import("../src/react-app/domains/aiopc/environment-lease");

const initialFetch = globalThis.fetch;
const initialBridge = window.__OPENWORK_ELECTRON__;
const project = "/company/projects/alpha";
const environment = "env-alpha";
const leasePath = "/api/environment/lease";
type Action = { action: string; sessionId: string; leaseId?: string; requestId?: string; bindingRevision: number };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let actions: Action[];
let acquisition: ReturnType<typeof Promise.withResolvers<Response>>;
let retry: ReturnType<typeof Promise.withResolvers<Response>>;

async function until(condition: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !condition()) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  expect(condition()).toBe(true);
}

function Viewer() {
  const lease = useEnvironmentLease(project, environment);
  return <>
    <button disabled={!lease.query.data} onClick={() => void lease.take()}>Take control</button>
    {lease.queued ? <button data-cancel onClick={() => void lease.cancel()}>Cancel</button> : null}
  </>;
}

beforeEach(() => {
  acquisition = Promise.withResolvers<Response>();
  retry = Promise.withResolvers<Response>();
  actions = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  Object.defineProperty(window, "__OPENWORK_ELECTRON__", {
    configurable: true,
    value: { aiopc: { connection: async () => ({ status: "ready", url: "http://localhost:9997", token: "test" }) } },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe(leasePath);
    expect(url.searchParams.get("workspace")).toBe(project);
    expect(url.searchParams.get("environment")).toBe(environment);
    if (init?.method === "POST") {
      const action = JSON.parse(String(init.body)) as Action;
      actions.push(action);
      if (action.action === "acquire") {
        return actions.filter(item => item.action === "acquire").length === 1 ? acquisition.promise : retry.promise;
      }
      return Response.json({ ok: true });
    }
    return Response.json({ holder: null, queue: [], bindingRevision: 4 });
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  globalThis.fetch = initialFetch;
});

afterAll(() => {
  Object.defineProperty(window, "__OPENWORK_ELECTRON__", { configurable: true, value: initialBridge });
});

async function startAcquiring() {
  await act(async () => root.render(<QueryClientProvider client={client}><Viewer /></QueryClientProvider>));
  await until(() => host.querySelector("button")?.disabled === false);
  await act(async () => host.querySelector("button")!.click());
  await until(() => actions.some(action => action.action === "acquire"));
  return actions.find(action => action.action === "acquire")!;
}

test("releases a manual lease granted after the environment view closes", async () => {
  const request = await startAcquiring();
  await act(async () => root.render(null));
  await act(async () => acquisition.resolve(Response.json({
    state: "granted",
    leaseId: "late-lease",
    holder: { ownerKey: "owner", kind: "human", sessionId: request.sessionId, label: "You",
      expiresAt: Date.now() + 60_000, waitingForUser: false },
  })));
  await until(() => actions.some(action => action.action === "release"));
  expect(actions.find(action => action.action === "release")).toMatchObject({
    leaseId: "late-lease", sessionId: request.sessionId, bindingRevision: 4,
  });
});

test("cancels a queue ticket returned after the environment view closes", async () => {
  const request = await startAcquiring();
  await act(async () => root.render(null));
  await act(async () => acquisition.resolve(Response.json({
    state: "queued", requestId: request.requestId ?? "late-ticket", position: 1, holder: null,
  })));
  const ticket = request.requestId ?? "late-ticket";
  await until(() => actions.some(action => action.action === "cancel" && action.requestId === ticket));
  expect(actions.find(action => action.action === "cancel" && action.requestId === ticket)).toMatchObject({
    sessionId: request.sessionId, bindingRevision: 4,
  });
});

test("discarding a queue ticket also releases a lease granted by an in-flight retry", async () => {
  const request = await startAcquiring();
  const ticket = request.requestId ?? "retry-ticket";
  await act(async () => acquisition.resolve(Response.json({ state: "queued", requestId: ticket, position: 1, holder: null })));
  await until(() => actions.filter(action => action.action === "acquire").length === 2, 3000);
  const cancel = host.querySelector<HTMLButtonElement>("[data-cancel]");
  expect(cancel).not.toBeNull();
  await act(async () => cancel!.click());
  await until(() => actions.some(action => action.action === "cancel" && action.requestId === ticket));
  await act(async () => retry.resolve(Response.json({
    state: "granted",
    leaseId: "after-cancel",
    holder: { ownerKey: "owner", kind: "human", sessionId: request.sessionId, label: "You",
      expiresAt: Date.now() + 60_000, waitingForUser: false },
  })));
  await until(() => actions.some(action => action.action === "release" && action.leaseId === "after-cancel"));
  expect(host.querySelector("[data-cancel]")).toBeNull();
});
