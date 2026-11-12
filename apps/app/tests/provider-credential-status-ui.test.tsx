/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { credentialHealthKey, useProviderCredentialHealth, type ProviderCredentialHealth } from "../src/react-app/domains/connections/provider-auth/credential-health";
import { AiSettingsView, type AiSettingsViewProps } from "../src/react-app/domains/settings/pages/ai-view";
import { LocalProviderStatus } from "../src/react-app/domains/settings/pages/provider-rows";

test("local credential status is opt-in and unverified is neutral", () => {
  expect(renderToStaticMarkup(<LocalProviderStatus />)).toContain("Ready to use");
  const unchecked = renderToStaticMarkup(<LocalProviderStatus credentialHealth="unverified" />);
  expect(unchecked).toContain("Not checked yet");
  expect(unchecked).toContain("text-muted-foreground");
  expect(unchecked).not.toContain("Ready to use");
  expect(renderToStaticMarkup(<LocalProviderStatus credentialHealth="verified" />)).toContain("Ready to use");
  const rejected = renderToStaticMarkup(<LocalProviderStatus credentialHealth="rejected" />);
  expect(rejected).toContain("Key not accepted");
  expect(rejected).toContain("text-amber-11");
});

test("engine availability stays above credential health", () => {
  const healthStates: ProviderCredentialHealth[] = ["unverified", "verified", "rejected"];
  for (const credentialHealth of healthStates) {
    const unavailable = renderToStaticMarkup(<LocalProviderStatus state="not_on_engine" credentialHealth={credentialHealth} />);
    expect(unavailable).toContain("Not available on the new engine yet");
    expect(unavailable).not.toContain("Ready to use");
  }
});

const localView: AiSettingsViewProps = {
  busy: false,
  runtimeWorkspaceId: "workspace-test",
  providerAuthBusy: false,
  providerStatusLabel: "",
  providerStatusStyle: "",
  providerSummary: "",
  providerLoadState: { status: "ready", error: null },
  onRetryProviders: () => {},
  connectedProviders: [{ id: "provider-test", name: "Test provider", source: "api" }],
  disconnectingProviderId: null,
  providerConnectError: null,
  providerDisconnectStatus: null,
  providerDisconnectError: null,
  onOpenProviderAuth: () => {},
  onReplaceProviderKey: () => {},
  onDisconnectProvider: () => {},
  canDisconnectProvider: () => true,
  canAddProviders: true,
  autoSwitchedOff: true,
};

test("local rejected key recovery is scoped to this runtime workspace", () => {
  const initialState = useProviderCredentialHealth.getInitialState();
  const key = credentialHealthKey("workspace-test", "provider-test");
  const previous = initialState.entries[key];
  // Server rendering reads Zustand's initial snapshot, not its current snapshot.
  initialState.entries[key] = { status: "rejected", revision: 0, observedAt: 0 };
  try {
    const rejected = renderToStaticMarkup(<AiSettingsView {...localView} />);
    expect(rejected).toContain("Key not accepted");
    expect(rejected).toContain("Replace key");
    const otherWorkspace = renderToStaticMarkup(<AiSettingsView {...localView} runtimeWorkspaceId="other-workspace" />);
    expect(otherWorkspace).toContain("Not checked yet");
    expect(otherWorkspace).not.toContain("Replace key");
    const environment = renderToStaticMarkup(<AiSettingsView {...localView} connectedProviders={[{ id: "provider-test", name: "Test provider", source: "env" }]} canDisconnectProvider={() => false} />);
    expect(environment).toContain("Update the environment credential");
    expect(environment).not.toContain("Replace key");
  } finally {
    if (previous) initialState.entries[key] = previous;
    else delete initialState.entries[key];
  }
});
