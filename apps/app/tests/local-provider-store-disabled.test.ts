import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

beforeEach(() => { GlobalRegistrator.register({ url: "http://localhost:5173/" }); });
afterEach(async () => {
  getReactQueryClient().clear();
  await GlobalRegistrator.unregister();
});

test("ENG-994: disabling OpenCode Zen on mount keeps a provider another route disconnected", async () => {
  // The chat route disables Zen on every mount from its own (stale) copy of
  // the list. Writing that copy back re-enabled a provider Settings had just
  // disconnected, and the write repeated on every mount.
  let runtime = ["remote"];
  const writes: string[][] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/workspace/workspace/runtime-config/disabled-providers") {
      if (request.method === "POST") {
        const body: unknown = await request.json();
        runtime = typeof body === "object" && body !== null && "providers" in body && Array.isArray(body.providers)
          ? body.providers.filter((entry): entry is string => typeof entry === "string") : [];
        writes.push(runtime);
      }
      return Response.json({ ok: true, disabledProviders: runtime });
    }
    return Response.json({});
  });
  const chat = createLiveProviderStore();
  try {
    expect(await chat.ensureProjectProviderDisabledState("opencode", true)).toBe(true);
    expect(writes).toEqual([["remote", "opencode"]]);
    // A later mount finds Zen already disabled and writes nothing.
    expect(await chat.ensureProjectProviderDisabledState("opencode", true)).toBe(false);
    expect(writes).toEqual([["remote", "opencode"]]);
    // Nor when the list holds Zen in another position.
    runtime = ["opencode", "remote"];
    expect(await chat.ensureProjectProviderDisabledState("opencode", true)).toBe(false);
    expect(writes).toEqual([["remote", "opencode"]]);
  } finally {
    chat.dispose();
    fetch.mockRestore();
  }
});

function createLiveProviderStore(view: { generation?: number; baseUrl?: string; token?: string } = {}) {
  const server = createOpenworkServerClient({ baseUrl: view.baseUrl ?? "http://localhost:8787", token: view.token, hostToken: "fixture-host" });
  const client = createClientV2("http://localhost:8787/opencode2", "/workspace", {});
  return createProviderAuthStore({
    client: () => client,
    providers: () => [], providerDefaults: () => ({}), providerConnectedIds: () => [], disabledProviders: () => [],
    selectedWorkspaceDisplay: () => ({ id: "workspace", name: "Workspace", path: "/workspace", preset: "default", workspaceType: "local" }),
    providerBaseUrl: () => "http://localhost:8787/opencode2", selectedWorkspaceRoot: () => "/workspace",
    runtimeWorkspaceId: () => "workspace",
    openworkServer: { getSnapshot: () => ({
      openworkServerStatus: "connected", openworkServerClient: server,
      openworkServerCapabilities: { providerSync: true }, openworkServerAuth: { token: view.token, hostToken: "fixture-host" },
      ...(view.generation === undefined ? {} : { openworkServerHostInfo: { generation: view.generation } }),
    }) },
    setProviders: () => {}, setProviderDefaults: () => {}, setProviderConnectedIds: () => {}, setDisabledProviders: () => {},
    markOpencodeConfigReloadRequired: () => {},
  });
}
