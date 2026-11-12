import { useEffect, useMemo, useRef } from "react";
import type { Client, ProviderListItem, WorkspaceDisplay } from "@/app/types";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { useReloadCoordinator } from "@/react-app/shell/reload-coordinator";
import { type RouteWorkspace, workspaceLabel } from "@/react-app/shell/route-workspaces";
import { createSessionOpenworkServer, type SessionServerEndpoint } from "./session-openwork-server";
import { createProviderAuthStore, useProviderAuthStoreSnapshot } from "./store";
import { useDesktopFeature } from "../../session/status/use-desktop-feature";

const emptyWorkspaceDisplay: WorkspaceDisplay = { id: "", name: "", path: "", preset: "default", workspaceType: "local" };

export type UseSessionProviderAuthInput = {
  opencodeClient: Client | null;
  opencodeBaseUrl: string;
  providers: ProviderListItem[];
  providerDefaults: Record<string, string>;
  providerConnectedIds: string[];
  disabledProviderIds: string[];
  selectedWorkspace: RouteWorkspace | null | undefined;
  selectedWorkspaceEndpoint: ResolvedWorkspaceEndpoint | null;
  selectedWorkspaceRoot: string;
  selectedWorkspaceId: string;
  engineRootServer?: SessionServerEndpoint | null;
  localServerHostToken?: string;
  localServerGeneration?: number | null;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setDisabledProviderIds: (value: string[]) => void;
};


export function useSessionProviderAuth(input: UseSessionProviderAuthInput) {
  const claudeAgentEnabled = useDesktopFeature("claudeAgentProvider");
  const state = useRef({ ...input, claudeAgentEnabled });
  state.current = { ...input, claudeAgentEnabled };
  const { markReloadRequired } = useReloadCoordinator();
  const store = useMemo(() => createProviderAuthStore({
    claudeAgentEnabled: () => state.current.claudeAgentEnabled,
    nativeOpenworkClient: () => state.current.selectedWorkspaceEndpoint?.client ?? null,
    nativeWorkspaceId: () => state.current.selectedWorkspaceEndpoint?.workspaceId ?? null,
    client: () => state.current.opencodeClient,
    providers: () => state.current.providers,
    providerDefaults: () => state.current.providerDefaults,
    providerConnectedIds: () => state.current.providerConnectedIds,
    disabledProviders: () => state.current.disabledProviderIds,
    providerBaseUrl: () => state.current.opencodeBaseUrl,
    selectedWorkspaceDisplay: () => state.current.selectedWorkspace
      ? { ...state.current.selectedWorkspace, name: workspaceLabel(state.current.selectedWorkspace) } as WorkspaceDisplay
      : emptyWorkspaceDisplay,
    selectedWorkspaceRoot: () => state.current.selectedWorkspaceRoot,
    runtimeWorkspaceId: () => state.current.selectedWorkspaceEndpoint?.workspaceId ?? null,
    openworkServer: createSessionOpenworkServer({
      endpoint: () => state.current.selectedWorkspaceEndpoint ?? state.current.engineRootServer ?? null,
      hostToken: () => state.current.localServerHostToken ?? "",
      generation: () => state.current.localServerGeneration ?? null,
    }),
    setProviders: value => state.current.setProviders(value),
    setProviderDefaults: value => state.current.setProviderDefaults(value),
    setProviderConnectedIds: value => state.current.setProviderConnectedIds(value),
    setDisabledProviders: value => state.current.setDisabledProviderIds(value),
    markOpencodeConfigReloadRequired: () => markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" }),
  }), [markReloadRequired]);

  useEffect(() => { store.start(); return () => store.dispose(); }, [store]);
  useEffect(() => { store.syncFromOptions(); }, [store, claudeAgentEnabled, input.opencodeClient,
    input.selectedWorkspaceId, input.selectedWorkspaceRoot, input.selectedWorkspaceEndpoint, input.engineRootServer]);

  const onboardingPending = useRef(false);
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes("onboarding=1")) return;
    window.location.hash = hash.replace(/[?&]onboarding=1/, "");
    onboardingPending.current = true;
  }, []);
  useEffect(() => {
    if (!onboardingPending.current || !input.selectedWorkspaceEndpoint) return;
    onboardingPending.current = false;
    void store.openProviderAuthModal({ returnFocusTarget: "composer" });
  }, [input.selectedWorkspaceEndpoint, store]);

  return { store, snapshot: useProviderAuthStoreSnapshot(store) };
}
