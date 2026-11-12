/** @jsxImportSource react */
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { deviceProviders, localProviderEngineStates } from "../src/react-app/domains/connections/provider-auth/local-provider-engine-state";
import { LocalProviderStatus } from "../src/react-app/domains/settings/pages/provider-rows";

const status = {
  enabled: true,
  chatRouting: true,
  mirroredProviderIds: ["anthropic"],
  skippedProviders: [
    { id: "openrouter", reason: "credentials" as const },
    { id: "openai", reason: "oauth" as const },
    { id: "google", reason: "unsupported" as const },
  ],
};

afterEach(() => {
  mock.restore();
});

test("a provider OpenCode v2 mirrored is ready, a skipped one is never ready and its reason decides its state", () => {
  const states = localProviderEngineStates(status);
  expect([...states]).toEqual([
    ["anthropic", "ready"],
    ["openrouter", "not_on_engine"],
    ["openai", "not_on_engine"],
    ["google", "not_on_engine"],
  ]);
});

test("On this device lists every provider the engine reports, even when v1's cached list has not caught up", () => {
  const nameFor = (id: string) => ({ anthropic: "Anthropic", google: "Google" }[id] ?? id);
  // v1 still lists only the first key; the second one is mirrored and in the picker.
  const connected = [{ id: "openrouter", name: "OpenRouter", source: "api" as const }, { id: "lpr_team", name: "Team models" }];
  const engine = localProviderEngineStates({ enabled: true, chatRouting: true, mirroredProviderIds: ["openrouter", "anthropic", "lpr_team"], skippedProviders: [{ id: "google", reason: "unsupported" }, { id: "openai", reason: "oauth" }] });

  expect(deviceProviders({ connected, engine, hidden: new Set(["openai"]), nameFor })).toEqual([
    { id: "openrouter", name: "OpenRouter", source: "api" },
    { id: "lpr_team", name: "Team models" },
    { id: "anthropic", name: "Anthropic" },
    { id: "google", name: "Google" },
  ]);
  // Without the engine's view (v1 chat, an older server, the rollout off) the list is v1's, unchanged.
  expect(deviceProviders({ connected, engine: localProviderEngineStates(null), hidden: new Set(), nameFor })).toEqual(connected);
});

test("nothing changes on v1, while v2 is not chat's engine, or when the server does not explain its skips", () => {
  expect(localProviderEngineStates({ ...status, chatRouting: false }).size).toBe(0);
  expect(localProviderEngineStates({ ...status, enabled: false }).size).toBe(0);
  expect(localProviderEngineStates({ enabled: true, chatRouting: true, mirroredProviderIds: ["anthropic"] }).size).toBe(0);
  expect(localProviderEngineStates(null).size).toBe(0);
});

test("rows distinguish usable providers from unavailable adapters", () => {
  const ready = renderToStaticMarkup(<LocalProviderStatus />);
  const mirrored = renderToStaticMarkup(<LocalProviderStatus state="ready" />);
  const unavailable = renderToStaticMarkup(<LocalProviderStatus state="not_on_engine" />);

  expect(ready).toContain("Ready to use");
  expect(mirrored).toContain("Ready to use");
  expect(unavailable).toContain("Not available on the new engine yet");
  expect(unavailable).not.toContain("Ready to use");
});

test("the status client reads skip reasons, keeps older servers working and never reads an unknown reason as ready", async () => {
  const body = {
    enabled: true, running: true, chatRouting: true,
    mirroredProviderIds: ["openrouter"], skippedProviderIds: ["openai", "future"], catalogModelIds: [],
    skippedProviders: [{ id: "openai", reason: "oauth" }, { id: "future", reason: "something-new" }, { reason: "policy" }],
  };
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  const client = createOpenworkServerClient({ baseUrl: "http://localhost:8787", token: "test" });

  const current = await client.getEngineV2PreviewStatus();
  expect(current.skippedProviders).toEqual([{ id: "openai", reason: "oauth" }, { id: "future", reason: "unsupported" }]);

  const { skippedProviders: _omitted, ...older } = body;
  fetch.mockResolvedValue(new Response(JSON.stringify(older), { status: 200 }));
  const legacy = await client.getEngineV2PreviewStatus();
  expect(legacy.skippedProviders).toBeUndefined();
  expect(legacy.skippedProviderIds).toEqual(["openai", "future"]);
});
