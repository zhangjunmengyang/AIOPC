import { useSyncExternalStore } from "react";
import { providerCredentialScope, useProviderCredentialHealth } from "./credential-health";
import { createClientV2, isOpencodeV2BaseUrl } from "@/app/lib/opencode-v2-adapter";
import { CLAUDE_AGENT_HOST_PROVIDER_ID, CLAUDE_AGENT_PROVIDER_ID, CLAUDE_CODE_CHECK_TIMEOUT_MESSAGE, CLAUDE_CODE_CHECK_TIMEOUT_MS, CLAUDE_CODE_NAME, CLAUDE_CODE_SIGN_IN_POLL_MS, claudeCodeMissing, plainClaudeMessage, type ClaudeAgentSetupState, type ClaudeAgentIntegration } from "@/app/lib/claude-agent";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { fetchProviderCatalog, providerListQueryKey, refreshProviderListQueries } from "../../../infra/provider-list-query";

import { applyEdits, modify, parse } from "jsonc-parser";
import type {
  ProviderAuthAuthorization,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2/client";

import { t } from "../../../../i18n";
import { unwrap, waitForHealthy } from "../../../../app/lib/opencode";
import {
  readOpencodeConfig,
  writeOpencodeConfig,
  engineRestart,
} from "../../../../app/lib/desktop";
import { buildOpenworkWorkspaceBaseUrl, OpenworkServerError } from "../../../../app/lib/openwork-server";
import type {
  Client,
  ProviderListItem,
  WorkspaceDisplay,
} from "../../../../app/types";
import { isDesktopRuntime, safeStringify } from "../../../../app/utils";
import {
  compareProviders,
  filterProviderList,
} from "../../../../app/utils/providers";
import { getReactQueryClient } from "../../../infra/query-client";
import {
  ensureProviderCatalogQuery,
  ensureProviderListQuery,
} from "../../../infra/provider-list-query";
import type { OpenworkServerStoreSnapshot } from "../openwork-server-store";

/**
 * The slice of the openwork-server store this store actually consumes.
 * The settings route passes the full store; the session route passes a
 * lightweight endpoint-backed adapter (previously forced through `as never`).
 */
export type ProviderAuthOpenworkServer = {
  getSnapshot: () => Pick<
    OpenworkServerStoreSnapshot,
    "openworkServerStatus" | "openworkServerClient"
  > & {
    openworkServerAuth?: { token?: string; hostToken?: string };
    openworkServerHostInfo?: { generation: number | null } | null;
    openworkServerCapabilities: { config?: { read?: boolean; write?: boolean }; providerSync?: boolean } | null;
  };
};
import { dispatchNewProviders, dispatchProviderCatalogChanged } from "../../../../app/lib/provider-events";
import { readManagedDisabledProviders, updateManagedDisabledProviders } from "../managed-engine-config";

type ProviderReturnFocusTarget = "none" | "composer";

let lastGlobalProviderDisposeRefreshAt = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableConfigValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableConfigValue(value[key])]),
  );
}

function canonicalConfig(raw: string): string | null {
  const parsed: unknown = parse(raw);
  if (parsed === undefined && raw.trim()) return null;
  return JSON.stringify(stableConfigValue(parsed ?? {}));
}

function configsAreSemanticallyEqual(left: string, right: string): boolean {
  if (left === right) return true;
  const leftCanonical = canonicalConfig(left);
  const rightCanonical = canonicalConfig(right);
  return leftCanonical !== null && leftCanonical === rightCanonical;
}

export type ProviderAuthMethod = {
  type: "oauth" | "api" | "external";
  label: string;
  methodIndex?: number;
};

export type ProviderAuthProvider = {
  id: string;
  name: string;
  env: string[];
};

export type ProviderOAuthStartResult = {
  methodIndex: number;
  authorization: ProviderAuthAuthorization;
};

export type ProviderLoadState = {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
};

export type ProviderAuthStoreSnapshot = {
  claudeAgent?: ClaudeAgentSetupState;
  providerLoadState: ProviderLoadState;
  providerAuthModalOpen: boolean;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  providerAuthMethods: Record<string, ProviderAuthMethod[]>;
  providerAuthPreferredProviderId: string | null;
  providerAuthProviders: ProviderAuthProvider[];
};

type CreateProviderAuthStoreOptions = {
  claudeAgentEnabled?: () => boolean;
  /** Test seam: how often the Claude Code check is read, how long a repeat check waits for a late problem, and when it gives up. */
  claudeCheckTiming?: { pollMs?: number; settleMs?: number; timeoutMs?: number; followUpMs?: number; signInPollMs?: number };
  /** Test seam. By default OpenWork runs Claude Code's sign-in only from the desktop app, on a workspace on this computer whose server it started. */
  claudeSignInAvailable?: () => boolean;
  nativeOpenworkClient?: () => OpenworkServerClient | null;
  nativeWorkspaceId?: () => string | null;
  client: () => Client | null;
  providers: () => ProviderListItem[];
  providerDefaults: () => Record<string, string>;
  providerConnectedIds: () => string[];
  disabledProviders: () => string[];
  selectedWorkspaceDisplay: () => WorkspaceDisplay;
  providerBaseUrl: () => string;
  selectedWorkspaceRoot: () => string;
  runtimeWorkspaceId: () => string | null;
  ensureRuntimeWorkspaceId?: () => Promise<string | null | undefined>;
  openworkServer: ProviderAuthOpenworkServer;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setDisabledProviders: (value: string[]) => void;
  markOpencodeConfigReloadRequired: () => void;
  focusPromptSoon?: () => void;
};

type MutableState = {
  providerLoadState: ProviderLoadState;
  providerAuthModalOpen: boolean;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  providerAuthMethods: Record<string, ProviderAuthMethod[]>;
  providerAuthPreferredProviderId: string | null;
  providerAuthReturnFocusTarget: ProviderReturnFocusTarget;
};

export type ProviderAuthStore = ReturnType<typeof createProviderAuthStore>;

export function createProviderAuthStore(options: CreateProviderAuthStoreOptions) {
  const listeners = new Set<() => void>();

  let snapshot: ProviderAuthStoreSnapshot;
  let disposed = false;
  let started = false;
  let claudeIntegration: ClaudeAgentIntegration | null = null;
  let claudeBusy = false;
  let claudeChecking = false;
  let claudeVerified = false;
  let claudeError: string | null = null;
  let claudeContext = "";
  let claudeFollowUp: ReturnType<typeof setTimeout> | null = null;
  let claudeIdleWaiters: Array<() => void> = [];
  // "checking": asking whether Claude Code is already signed in. "browser": its sign-in is open and unfinished.
  let claudeSignIn: "idle" | "checking" | "browser" = "idle";
  let claudeSignInRun = 0;
  // Whether Claude Code is on this computer, as the OpenWork server last saw it for `claudeInstalledContext`.
  let claudeInstalled: boolean | null = null;
  let claudeInstalledContext = "";
  const nativeTarget = () => ({
    client: options.nativeOpenworkClient ? options.nativeOpenworkClient() : options.openworkServer.getSnapshot().openworkServerClient,
    workspaceId: (options.nativeWorkspaceId ? options.nativeWorkspaceId() : options.runtimeWorkspaceId())?.trim() || null,
  });
  const nativeContext = () => {
    const target = nativeTarget();
    return JSON.stringify([target.client?.baseUrl, target.client?.token, target.workspaceId]);
  };
  /**
   * Claude Code sign-in is offered only when the person can use it: the
   * feature is on and a workspace
   * engine is reachable. Otherwise nothing about it is shown or read.
   */
  const claudeAvailable = () => {
    if (!options.claudeAgentEnabled?.()) return false;
    const target = nativeTarget();
    return Boolean(target.workspaceId && target.client);
  };
  const claudeLoginOffered = () => claudeAvailable() && claudeContext === nativeContext()
    && Boolean(claudeIntegration?.methods.some((method) => method.id === "claude-login" && method.type === "external"));
  const claudeCanSignIn = () => options.claudeSignInAvailable
    ? options.claudeSignInAvailable()
    : isDesktopRuntime() && options.selectedWorkspaceDisplay().workspaceType === "local" && Boolean(nativeTarget().client?.canSignInToClaudeCode);
  const claudeSetupState = (): ClaudeAgentSetupState | undefined => {
    if (!claudeAvailable()) return undefined;
    const current = claudeContext === nativeContext();
    return {
      integration: current ? claudeIntegration : null,
      busy: claudeBusy || claudeSignIn !== "idle",
      checking: claudeChecking || claudeSignIn === "checking",
      verified: current && claudeVerified,
      error: current ? claudeError : null,
      canSignIn: claudeCanSignIn(),
      signingIn: current && claudeSignIn === "browser",
      ...(claudeInstalled !== null && claudeInstalledContext === nativeContext() ? { installed: claudeInstalled } : {}),
    };
  };

  let state: MutableState = {
    providerLoadState: { status: "idle", error: null },
    providerAuthModalOpen: false,
    providerAuthBusy: false,
    providerAuthError: null,
    providerAuthMethods: {},
    providerAuthPreferredProviderId: null,
    providerAuthReturnFocusTarget: "none",
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
   };

  // Providers that are not connected yet, loaded only when the Connect modal
  // opens. The everyday provider list holds connected providers only.
  let providerCatalog: ProviderListItem[] = [];

  const getProviderAuthProviders = (): ProviderAuthProvider[] => {
    const merged = new Map<string, ProviderAuthProvider>();

    for (const provider of [...options.providers(), ...providerCatalog]) {
      const id = provider.id?.trim();
      if (!id || merged.has(id)) continue;
      merged.set(id, {
        id,
        name: provider.name?.trim() || id,
        env: Array.isArray(provider.env) ? provider.env : [],
      });
    }


    // Claude Code is a way to connect Anthropic, so Anthropic is listed even
    // when the engine's own provider list could not be read.
    if (claudeLoginOffered() && !merged.has(CLAUDE_AGENT_HOST_PROVIDER_ID)) {
      merged.set(CLAUDE_AGENT_HOST_PROVIDER_ID, { id: CLAUDE_AGENT_HOST_PROVIDER_ID, name: "Anthropic", env: [] });
    }
    return Array.from(merged.values()).toSorted(compareProviders);
  };

  const resolveOpenworkConfigTarget = async (mode: "read" | "write") => {
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    let openworkWorkspaceId = options.runtimeWorkspaceId()?.trim() || null;
    if (!openworkWorkspaceId && openworkSnapshot.openworkServerStatus === "connected" && openworkClient) {
      openworkWorkspaceId = (await options.ensureRuntimeWorkspaceId?.())?.trim() || null;
    }
    const hasOpenworkTarget =
      openworkSnapshot.openworkServerStatus === "connected" &&
      Boolean(openworkClient && openworkWorkspaceId);
    const canUseOpenworkServer =
      hasOpenworkTarget &&
      openworkSnapshot.openworkServerCapabilities?.config?.[mode] !== false;
    return {
      openworkClient,
      openworkWorkspaceId,
      hasOpenworkTarget,
      canUseOpenworkServer,
    };
  };

  const refreshSnapshot = () => {
    snapshot = {
      claudeAgent: claudeSetupState(),
      providerLoadState: state.providerLoadState,
      providerAuthModalOpen: state.providerAuthModalOpen,
      providerAuthBusy: state.providerAuthBusy,
      providerAuthError: state.providerAuthError,
      providerAuthMethods: state.providerAuthMethods,
      providerAuthPreferredProviderId: state.providerAuthPreferredProviderId,
      providerAuthProviders: getProviderAuthProviders(),
    };
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    refreshSnapshot();
    emitChange();
  };

  const setStateField = <K extends keyof MutableState>(
    key: K,
    value: MutableState[K],
  ) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const readProjectConfigFile = async () => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace =
      options.selectedWorkspaceDisplay().workspaceType === "local";
    const { openworkClient, openworkWorkspaceId, hasOpenworkTarget, canUseOpenworkServer } =
      await resolveOpenworkConfigTarget("read");

    if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
      return await openworkClient.readOpencodeConfigFile(openworkWorkspaceId, "project");
    }

    if (hasOpenworkTarget) {
      throw new Error("OpenWork server config API is unavailable for this workspace.");
    }

    if (isLocalWorkspace && isDesktopRuntime() && root) {
      return await readOpencodeConfig("project", root);
    }

    return null;
  };

  const writeProjectConfigFile = async (content: string, isCurrent = () => true) => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace =
      options.selectedWorkspaceDisplay().workspaceType === "local";
    const { openworkClient, openworkWorkspaceId, hasOpenworkTarget, canUseOpenworkServer } =
      await resolveOpenworkConfigTarget("write");
    if (!isCurrent()) return false;

    if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
      const result = await openworkClient.writeOpencodeConfigFile(
        openworkWorkspaceId,
        "project",
        content,
      ) as { ok: boolean; stderr?: string; stdout?: string };
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || "Failed to write opencode.jsonc");
      }
      return true;
    }

    if (hasOpenworkTarget) {
      throw new Error("OpenWork server config API is unavailable for this workspace.");
    }

    if (isLocalWorkspace && isDesktopRuntime() && root) {
      const result = await writeOpencodeConfig("project", root, content) as { ok: boolean; stderr?: string; stdout?: string };
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || "Failed to write opencode.jsonc");
      }
      return true;
    }

    return false;
  };

  const updateProjectConfigFile = async (
    updater: (raw: string) => string,
    fallbackUpdate?: (config: Record<string, unknown>) => Record<string, unknown>,
    isCurrent = () => true,
  ) => {
    const configFile = await readProjectConfigFile() as { content?: string } | null;
    if (!isCurrent()) return false;
    if (configFile) {
      const raw = configFile.content?.trim()
        ? configFile.content
        : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
      const next = updater(raw);
      if (configsAreSemanticallyEqual(raw, next)) {
        return false;
      }
      return await writeProjectConfigFile(next, isCurrent);
    }

    if (!fallbackUpdate) {
      return false;
    }

    const c = options.client();
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const workspaceId = options.runtimeWorkspaceId();
    const workspaceType = options.selectedWorkspaceDisplay().workspaceType;
    const canUseManagedRuntime = Boolean(openworkSnapshot.openworkServerClient && workspaceId?.trim() && workspaceType === "local");
    if (!c && !canUseManagedRuntime) {
      throw new Error(t("providers.not_connected"));
    }
    const config = c ? unwrap(await c.config.get()) : {};
    const next = fallbackUpdate(config);
    await updateManagedDisabledProviders({
      opencodeClient: c,
      openworkClient: openworkSnapshot.openworkServerClient,
      workspaceId,
      workspaceType,
      disabledProviders: next.disabled_providers,
      currentConfig: config,
      removeFallbackKeyWhenEmpty: true,
    });
    return true;
  };

  const normalizeDisabledProviders = (value: unknown) =>
    Array.isArray(value)
      ? [
          ...new Set(
            value
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean),
          ),
        ]
      : [];

  const formatConfigWithProviderDisabledState = (
    raw: string,
    providerId: string,
    disabled: boolean,
  ) => {
    const resolvedProviderId = providerId.trim();
    let updated = raw.trim()
      ? raw
      : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
    const parsed = parse(updated) as Record<string, unknown> | undefined;
    const currentDisabled = normalizeDisabledProviders(parsed?.disabled_providers);
    const nextDisabled = disabled
      ? [...currentDisabled.filter((entry) => entry !== resolvedProviderId), resolvedProviderId]
      : currentDisabled.filter((entry) => entry !== resolvedProviderId);

    const disabledEdits = modify(
      updated,
      ["disabled_providers"],
      nextDisabled.length ? nextDisabled : undefined,
      { formattingOptions: { insertSpaces: true, tabSize: 2 } },
    );
    updated = applyEdits(updated, disabledEdits);
    return updated.endsWith("\n") ? updated : `${updated}\n`;
  };

  const ensureProjectProviderDisabledState = async (
    providerId: string,
    disabled: boolean,
  ) => {
    const resolvedProviderId = providerId.trim();
    if (!resolvedProviderId) {
      throw new Error(t("providers.provider_id_required"));
    }

    // Already in the requested state: keep the list as is (order included), so
    // a merged read in another order never looks like a change.
    const nextFrom = (currentDisabled: string[]) => currentDisabled.includes(resolvedProviderId) === disabled
      ? currentDisabled
      : disabled
        ? [...currentDisabled, resolvedProviderId]
        : currentDisabled.filter((entry) => entry !== resolvedProviderId);
    const unchanged = (currentDisabled: string[], nextDisabled: string[]) =>
      nextDisabled.length === currentDisabled.length &&
      nextDisabled.every((entry, index) => entry === currentDisabled[index]);

    // Prefer runtime OPENCODE_CONFIG injection (server SQLite) so OpenCode Zen
    // and other built-in/env-backed providers can be disabled without editing
    // the user's opencode.jsonc. Fall back to project config only when the
    // managed runtime endpoint is unavailable.
    const c = options.client();
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const workspaceId = options.runtimeWorkspaceId();
    const workspaceType = options.selectedWorkspaceDisplay().workspaceType;
    // Before the first workspace exists the client reaches the engine root,
    // whose config belongs to no workspace a person will open. Leave project
    // provider rules alone until there is a workspace to hold them.
    if (!workspaceId?.trim() && !options.selectedWorkspaceRoot().trim()) {
      return false;
    }
    const canUseManagedRuntime = Boolean(
      openworkSnapshot.openworkServerClient && workspaceId?.trim() && workspaceType === "local",
    );

    if (canUseManagedRuntime || c) {
      // Each write replaces the whole list. This store's copy can be stale (the
      // chat route disables OpenCode Zen on every mount, after Settings may
      // have disconnected another provider), and writing it back re-enabled
      // that provider (ENG-994). Build on the current list.
      const currentDisabled = normalizeDisabledProviders(await readManagedDisabledProviders({
        opencodeClient: c,
        openworkClient: openworkSnapshot.openworkServerClient,
        workspaceId,
        workspaceType,
      }).catch(() => options.disabledProviders()));
      const nextDisabled = nextFrom(currentDisabled);
      if (unchanged(currentDisabled, nextDisabled)) {
        if (!unchanged(normalizeDisabledProviders(options.disabledProviders()), currentDisabled)) {
          options.setDisabledProviders(currentDisabled);
        }
        return false;
      }
      const result = await updateManagedDisabledProviders({
        opencodeClient: c,
        openworkClient: openworkSnapshot.openworkServerClient,
        workspaceId,
        workspaceType,
        disabledProviders: nextDisabled,
        removeFallbackKeyWhenEmpty: true,
        markReloadRequired: () => options.markOpencodeConfigReloadRequired(),
      });
      options.setDisabledProviders(result.disabledProviders);
      options.markOpencodeConfigReloadRequired();
      refreshSnapshot();
      emitChange();
      return true;
    }

    const currentDisabled = normalizeDisabledProviders(options.disabledProviders());
    const nextDisabled = nextFrom(currentDisabled);
    if (unchanged(currentDisabled, nextDisabled)) return false;

    const updatedConfig = await updateProjectConfigFile(
      (raw) => formatConfigWithProviderDisabledState(raw, resolvedProviderId, disabled),
      (config) => {
        const nextConfig = { ...config };
        if (nextDisabled.length) {
          nextConfig.disabled_providers = nextDisabled;
        } else {
          delete nextConfig.disabled_providers;
        }
        return nextConfig;
      },
    );

    if (!updatedConfig) {
      throw new Error("Could not update disabled providers for this workspace.");
    }

    options.setDisabledProviders(nextDisabled);
    options.markOpencodeConfigReloadRequired();
    refreshSnapshot();
    emitChange();
    return true;
  };

  // Track whether the provider list has been loaded at least once.
  // The first load (app startup) populates the initial state — we don't
  // want to fire "new provider" events for providers that were already
  // there. After the first load, any new provider IS genuinely new.
  let providerListInitialized = false;

  const applyProviderListState = (value: ProviderListResponse, opts?: { suppressNewProviderEvent?: boolean }) => {
    const prevConnected = new Set(options.providerConnectedIds());
    const nextConnected = value.connected ?? [];
    const nextAll = value.all ?? [];
    options.setProviders(nextAll);
    options.setProviderDefaults(value.default ?? {});
    options.setProviderConnectedIds(nextConnected);
    refreshSnapshot();
    emitChange();

    if (!providerListInitialized) {
      providerListInitialized = true;
      return;
    }

    // Detect newly connected providers and fire a global event so
    // the NewProvidersListener records a notification — regardless of
    // which route is active.
    if (!opts?.suppressNewProviderEvent) {
      const newIds = nextConnected.filter((id) => !prevConnected.has(id));
      if (newIds.length > 0) {
        const infos = newIds.map((id) => {
          const provider = nextAll.find((p) => (p.id ?? "") === id);
          const models = provider?.models ?? {};
          const firstModelId = Object.keys(models)[0];
          return {
            id,
            name: provider?.name ?? id,
            providerId: id,
            firstModelId,
            firstModelName: firstModelId
              ? (models[firstModelId]?.name ?? firstModelId)
              : undefined,
          };
        });
        dispatchNewProviders({ providers: infos, source: "local_config" });
      }
    }
  };

  const removeProviderFromState = (providerId: string) => {
    const resolved = providerId.trim();
    if (!resolved) return;
    options.setProviders(options.providers().filter((provider) => provider.id !== resolved));
    options.setProviderConnectedIds(
      options.providerConnectedIds().filter((id) => id !== resolved),
    );
    options.setProviderDefaults(
      Object.fromEntries(
        Object.entries(options.providerDefaults()).filter(([id]) => id !== resolved),
      ),
    );
    refreshSnapshot();
    emitChange();
  };

  const assertNoClientError = (result: unknown) => {
    const maybe = result as { error?: unknown } | null | undefined;
    if (!maybe || maybe.error === undefined) return;
    throw new Error(describeProviderError(maybe.error, t("providers.request_failed")));
  };

  const removeProviderAuthCredentials = async (providerId: string) => {
    const workspaceId = options.runtimeWorkspaceId();
    if (workspaceId && options.providerBaseUrl().trim()) useProviderCredentialHealth.getState().bindWorkspace(workspaceId, providerCredentialScope(options.providerBaseUrl()));
    const changed = () => { if (workspaceId) useProviderCredentialHealth.getState().changed(workspaceId, providerId); };
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }

    const authClient = c.auth as unknown as {
      remove?: (options: { providerID: string }) => Promise<unknown>;
      set?: (options: { providerID: string; auth: unknown }) => Promise<unknown>;
    };
    if (typeof authClient.remove === "function") {
      const result = await authClient.remove({ providerID: providerId });
      assertNoClientError(result);
      changed();
      return;
    }

    const rawClient = (c as unknown as {
      client?: { delete?: (options: { url: string }) => Promise<unknown> };
    }).client;
    if (rawClient?.delete) {
      assertNoClientError(await rawClient.delete({ url: `/auth/${encodeURIComponent(providerId)}` }));
      changed();
      return;
    }

    if (typeof authClient.set === "function") {
      const result = await authClient.set({ providerID: providerId, auth: null });
      assertNoClientError(result);
      changed();
      return;
    }

    throw new Error(t("providers.removal_unsupported"));
  };

  const describeProviderError = (error: unknown, fallback: string) => {
    const readString = (value: unknown, max = 700) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (trimmed.length <= max) return trimmed;
      return `${trimmed.slice(0, Math.max(0, max - 3))}...`;
    };

    const records: Record<string, unknown>[] = [];
    const root = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
    if (root) {
      records.push(root);
      if (root.data && typeof root.data === "object") {
        records.push(root.data as Record<string, unknown>);
      }
      if (root.cause && typeof root.cause === "object") {
        const cause = root.cause as Record<string, unknown>;
        records.push(cause);
        if (cause.data && typeof cause.data === "object") {
          records.push(cause.data as Record<string, unknown>);
        }
      }
    }

    const firstString = (keys: string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = readString(record[key]);
          if (value) return value;
        }
      }
      return null;
    };

    const firstNumber = (keys: string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = record[key];
          if (typeof value === "number" && Number.isFinite(value)) return value;
        }
      }
      return null;
    };

    const status = firstNumber(["statusCode", "status"]);
    const provider = firstString(["providerID", "providerId", "provider"]);
    const code = firstString(["code", "errorCode"]);
    const response = firstString(["responseBody", "body", "response"]);
    const raw =
      (error instanceof Error ? readString(error.message) : null) ||
      firstString(["message", "detail", "reason", "error"]) ||
      (typeof error === "string" ? readString(error) : null);

    const generic = raw && /^unknown\s+error$/i.test(raw);
    const heading = (() => {
      if (status === 401 || status === 403) return t("providers.auth_failed");
      if (status === 429) return t("providers.rate_limit_exceeded");
      if (provider) return t("providers.provider_error", { provider });
      return fallback;
    })();

    const lines = [heading];
    if (raw && !generic && raw !== heading) lines.push(raw);
    if (status && !heading.includes(String(status))) lines.push(`Status: ${status}`);
    if (provider && !heading.includes(provider)) lines.push(`Provider: ${provider}`);
    if (code) lines.push(`Code: ${code}`);
    if (response) lines.push(`Response: ${response}`);
    if (lines.length > 1) return lines.join("\n");

    if (raw && !generic) return raw;
    if (error && typeof error === "object") {
      const serialized = safeStringify(error);
      if (serialized && serialized !== "{}") return serialized;
    }
    return fallback;
  };

  const buildProviderAuthMethods = (
    methods: Record<string, ProviderAuthMethod[]>,
    availableProviders: ProviderAuthProvider[],
  ) => {
    const merged = Object.fromEntries(
      Object.entries(methods ?? {}).map(([id, providerMethods]) => [
        id,
        (providerMethods ?? []).map((method, methodIndex) => ({
          ...method,
          methodIndex,
        })),
      ]),
    ) as Record<string, ProviderAuthMethod[]>;

    for (const provider of availableProviders ?? []) {
      const id = provider.id?.trim();
      if (!id) continue;
      if (!Array.isArray(provider.env) || provider.env.length === 0) continue;
      const existing = merged[id] ?? [];
      if (existing.some((method) => method.type === "api")) continue;
      merged[id] = [...existing, { type: "api", label: t("providers.api_key_label") }];
    }

    const availableProvidersById = new Map((availableProviders ?? []).map((provider) => [provider.id, provider]));
    for (const [id, providerMethods] of Object.entries(merged)) {
      const provider = availableProvidersById.get(id);
      const normalizedId = id.trim().toLowerCase();
      const normalizedName = provider?.name?.trim().toLowerCase() ?? "";
      const isOpenAiProvider = normalizedId === "openai" || normalizedName === "openai";
      if (!isOpenAiProvider) continue;
      merged[id] = providerMethods.filter((method) => {
        if (method.type !== "oauth") return true;
        // Browser mode can't complete the ChatGPT sign-in flows, so only API keys
        // are offered off-desktop.
        if (!isDesktopRuntime()) return false;
        const label = method.label.toLowerCase();
        return !/headless|device/.test(label);
      });
    }

    return merged;
  };

  // Best effort: without the catalog the modal still offers connected
  // providers and sign-in methods.
  const loadProviderCatalog = async (client: Client) => {
    try {
      const catalog = filterProviderList(
        await ensureProviderCatalogQuery(getReactQueryClient(), {
          client,
          baseUrl: options.providerBaseUrl(),
          directory: options.selectedWorkspaceRoot(),
        }),
        options.disabledProviders(),
      );
      providerCatalog = catalog.all ?? [];
    } catch {
      providerCatalog = [];
    }
  };

  const claudeCatalogTarget = (target: { client: OpenworkServerClient; workspaceId: string }) => {
    const baseUrl = `${buildOpenworkWorkspaceBaseUrl(target.client.baseUrl, target.workspaceId)}/opencode2`;
    const directory = options.selectedWorkspaceRoot();
    return { baseUrl, directory, client: createClientV2(baseUrl, directory, { token: target.client.token }) };
  };

  /** Whether the engine lists Claude Code's models: true once a check of `claude` has finished at least once. */
  const readClaudeModels = async (target: { client: OpenworkServerClient; workspaceId: string }) => {
    const { client, directory } = claudeCatalogTarget(target);
    const list = await fetchProviderCatalog({ client, directory });
    return { list, listed: list.all.some((provider) => provider.id === CLAUDE_AGENT_PROVIDER_ID && Object.keys(provider.models ?? {}).length > 0) };
  };

  const publishClaudeCatalog = async (target: { client: OpenworkServerClient; workspaceId: string }, context: string, known?: ProviderListResponse) => {
    const { baseUrl, directory } = claudeCatalogTarget(target);
    // Always read the actual v2 catalog, including while Gateway live sync is off.
    try {
      const list = known ?? (await readClaudeModels(target)).list;
      if (disposed || nativeContext() !== context || !claudeAvailable()) return;
      getReactQueryClient().setQueryData(providerListQueryKey({ baseUrl, directory }), list);
      await refreshProviderListQueries(getReactQueryClient());
      if (disposed || nativeContext() !== context || !claudeAvailable()) return;
      dispatchProviderCatalogChanged({ baseUrl, directory });
    } catch {
      // The model picker reads the catalog again on its own; the connection itself is unaffected.
    }
  };

  const claudeWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /**
   * Connecting only records the choice; the engine then checks `claude` on its
   * own and reports a problem on the connection. Wait for that answer so the
   * person is told "connected" or the reason, never left on a saved reference.
   *
   * The engine keeps Claude Code's model list between checks and gives a new
   * connection no status until its check ends, so a repeat check looks clean
   * straight away. `settleMs` holds a repeat check open long enough for a
   * problem to arrive (about one second with Claude Code 2.1 on a Mac).
   */
  const waitForClaudeCheck = async (
    target: { client: OpenworkServerClient; workspaceId: string },
    input: { repeat: boolean; current: () => boolean },
  ): Promise<{ integration: ClaudeAgentIntegration; list?: ProviderListResponse; problem: string | null } | null> => {
    const pollMs = options.claudeCheckTiming?.pollMs ?? 600;
    const settleMs = input.repeat ? options.claudeCheckTiming?.settleMs ?? 5_000 : 0;
    const timeoutMs = options.claudeCheckTiming?.timeoutMs ?? CLAUDE_CODE_CHECK_TIMEOUT_MS;
    const started = Date.now();
    let cleanReads = 0;
    for (;;) {
      const integration = await target.client.claudeAgentIntegration(target.workspaceId);
      if (!input.current()) return null;
      const active = integration.connections[0];
      if (!active) throw new Error("Claude Code connection was not returned by the server. Check again before retrying.");
      if (active.status?.status === "needs_auth") return { integration, problem: active.status.message };
      const models = await readClaudeModels(target).catch(() => null);
      if (!input.current()) return null;
      const elapsed = Date.now() - started;
      // Models and the login problem arrive separately, so one clean read is
      // confirmed by a second before it counts as a working login.
      cleanReads = models?.listed && elapsed >= settleMs ? cleanReads + 1 : 0;
      if (cleanReads >= 2) return { integration, list: models?.list, problem: null };
      if (elapsed >= timeoutMs) throw new Error(CLAUDE_CODE_CHECK_TIMEOUT_MESSAGE);
      await claudeWait(pollMs);
      if (!input.current()) return null;
    }
  };

  async function runClaudeAction(action: "read" | "connect" | "disconnect") {
    if (claudeBusy) return;
    if (!claudeAvailable()) throw new Error("Claude Code sign-in is not available in this workspace.");
    const { client, workspaceId } = nativeTarget();
    if (!client || !workspaceId) throw new Error("Choose a workspace to connect Claude Code.");
    const target = { client, workspaceId };
    const context = nativeContext();
    if (claudeContext !== context) { claudeIntegration = null; claudeVerified = false; }
    claudeContext = context;
    claudeBusy = true;
    claudeChecking = action === "connect";
    claudeError = null;
    if (claudeFollowUp) { clearTimeout(claudeFollowUp); claudeFollowUp = null; }
    refreshSnapshot(); emitChange();
    const current = () => !disposed && context === nativeContext() && claudeAvailable();
    try {
      let integration = await client.claudeAgentIntegration(workspaceId);
      if (!current()) return;
      let list: ProviderListResponse | undefined;
      if (action === "connect") {
        if (!integration.methods.some((method) => method.id === "claude-login" && method.type === "external")) {
          throw new Error("Claude Code setup is unavailable on this server. Update OpenWork and check again.");
        }
        const previousIds = new Set(integration.connections.map((connection) => connection.id));
        // A repeat check is one where the engine already lists Claude Code's models.
        const repeat = (await readClaudeModels(target).catch(() => null))?.listed === true;
        if (!current()) return;
        claudeVerified = false;
        // Deliberately one POST: a timeout is uncertain, not permission to replay it.
        await client.connectClaudeAgent(workspaceId);
        if (!current()) return;
        integration = await client.claudeAgentIntegration(workspaceId);
        if (!current()) return;
        if (!integration.connections.length) throw new Error("Claude Code connection was not returned by the server. Check again before retrying.");
        const created = integration.connections.filter((connection) => !previousIds.has(connection.id));
        // Native order is active first. Other new IDs may belong to another
        // concurrent Connect; never treat those as our superseded references.
        const keep = integration.connections[0] ?? created[0];
        if (keep) {
          for (const connection of integration.connections) {
            if (!previousIds.has(connection.id) || connection.id === keep.id) continue;
            if (!current()) return;
            const latest = await client.claudeAgentIntegration(workspaceId);
            if (!current()) return;
            // Another client may have switched the active connection since our
            // POST. Preserve its active reference, even if it was in our snapshot.
            if (latest.connections[0]?.id === connection.id || !latest.connections.some((entry) => entry.id === connection.id)) continue;
            await client.removeClaudeAgentConnection(workspaceId, connection.id);
          }
          if (!current()) return;
        }
        const checked = await waitForClaudeCheck(target, { repeat, current });
        if (!checked || !current()) return;
        claudeIntegration = checked.integration;
        if (checked.problem) throw new Error(plainClaudeMessage(checked.problem));
        integration = checked.integration;
        list = checked.list;
        claudeVerified = true;
      } else if (action === "disconnect") {
        // Only connection references are removed. Claude Code stays signed in.
        for (const connection of integration.connections) {
          if (!current()) return;
          await client.removeClaudeAgentConnection(workspaceId, connection.id);
        }
        if (!current()) return;
        integration = await client.claudeAgentIntegration(workspaceId);
        if (!current()) return;
        if (integration.connections.length) throw new Error("Some Claude Code connections remain. Disconnect again to remove them.");
        claudeVerified = false;
      } else if (integration.connections[0]?.status?.status === "needs_auth" || !integration.connections.length) {
        claudeVerified = false;
      }
      if (!current()) return;
      claudeIntegration = integration;
      // The model picker catches up on its own; the person's result does not wait for it.
      if (action !== "read") void publishClaudeCatalog(target, context, list);
      if (action === "connect") {
        // A slow computer can report a sign-in problem after the wait above; read once more so the row stays true.
        claudeFollowUp = setTimeout(() => { claudeFollowUp = null; void runClaudeAction("read").catch(() => undefined); }, options.claudeCheckTiming?.followUpMs ?? 15_000);
      }
      return action === "disconnect" ? `Disconnected ${CLAUDE_CODE_NAME} from OpenWork. Claude Code itself stays signed in.` : `${CLAUDE_CODE_NAME} connected`;
    } catch (error) {
      if (!current()) return;
      claudeError = error instanceof Error ? error.message : "Could not check Claude Code. Check again.";
      throw error;
    } finally {
      claudeBusy = false;
      claudeChecking = false;
      for (const resolve of claudeIdleWaiters.splice(0)) resolve();
      if (!disposed) {
        refreshSnapshot(); emitChange();
        if (context !== nativeContext() && claudeAvailable()) void runClaudeAction("read").catch(() => undefined);
      }
    }
  }

  const noteClaudeInstalled = (context: string, installed: boolean | undefined) => {
    if (installed === undefined || disposed || context !== nativeContext()) return;
    // Installed since it was reported missing: that reason no longer holds.
    const stale = installed && claudeContext === context && claudeCodeMissing(claudeError);
    if (!stale && claudeInstalled === installed && claudeInstalledContext === context) return;
    if (stale) claudeError = null;
    claudeInstalled = installed;
    claudeInstalledContext = context;
    refreshSnapshot(); emitChange();
  };

  /** Looks for Claude Code on this computer: when its step opens, and again when the person comes back from installing it. */
  async function checkClaudeInstalled() {
    if (!claudeAvailable() || !claudeCanSignIn() || claudeBusy || claudeSignIn !== "idle") return;
    const { client } = nativeTarget();
    if (!client) return;
    const context = nativeContext();
    // A server too old to say leaves it unknown; Connect then finds out.
    const signIn = await client.claudeCodeSignIn("status").catch(() => null);
    noteClaudeInstalled(context, signIn?.installed);
  }

  /**
   * Has the OpenWork server on this computer make sure Claude Code is signed
   * in (opening Claude Code's own browser sign-in, `claude auth login`, when it
   * is not), waits for the person to finish, then connects exactly as Connect
   * does. OpenWork never sees the login.
   */
  async function signInWithClaudeCode() {
    if (claudeBusy || claudeSignIn !== "idle") return;
    if (!claudeAvailable() || !claudeCanSignIn()) throw new Error("Claude Code sign-in is not available in this workspace.");
    const { client } = nativeTarget();
    if (!client) throw new Error("Choose a workspace to connect Claude Code.");
    const context = nativeContext();
    const run = ++claudeSignInRun;
    if (claudeContext !== context) { claudeIntegration = null; claudeVerified = false; claudeError = null; }
    claudeContext = context;
    // After a check that failed, the login Claude Code holds is the problem: ask for a fresh one.
    // A Claude Code that was missing has no login to replace: ask whether the new install is signed in first.
    const problem = claudeIntegration?.connections[0]?.status;
    const force = claudeError ? !claudeCodeMissing(claudeError) : problem?.status === "needs_auth" && !claudeCodeMissing(problem.message);
    claudeSignIn = force ? "browser" : "checking";
    claudeError = null;
    refreshSnapshot(); emitChange();
    const current = () => !disposed && run === claudeSignInRun && context === nativeContext() && claudeAvailable();
    let signedIn = false;
    try {
      let signIn = await client.claudeCodeSignIn("start", { force });
      noteClaudeInstalled(context, signIn.installed);
      while (signIn.status === "waiting") {
        await claudeWait(options.claudeCheckTiming?.signInPollMs ?? CLAUDE_CODE_SIGN_IN_POLL_MS);
        if (!current()) break;
        signIn = await client.claudeCodeSignIn("status");
        // Still waiting after a first look: Claude Code was not signed in, so its sign-in is open in the browser.
        if (signIn.status === "waiting" && claudeSignIn === "checking" && current()) { claudeSignIn = "browser"; refreshSnapshot(); emitChange(); }
      }
      if (!current()) {
        // The workspace or permission changed while the browser was open: stop waiting, unless Cancel already did.
        if (run === claudeSignInRun) void client.claudeCodeSignIn("cancel").catch(() => undefined);
        return;
      }
      if (signIn.status === "failed") throw new Error(signIn.message);
      // Idle: another window canceled this sign-in. Nothing to report.
      signedIn = signIn.status === "signed_in";
    } catch (error) {
      if (!current()) return;
      if (error instanceof OpenworkServerError && error.code === "claude_code_not_installed") noteClaudeInstalled(context, false);
      claudeError = error instanceof OpenworkServerError && error.status === 404
        ? "This OpenWork server cannot open the Claude Code sign-in. Run claude auth login in a terminal, then connect."
        : error instanceof Error ? error.message : "Could not sign in to Claude Code. Sign in again.";
      throw error;
    } finally {
      // A confirmed login goes straight on to the engine's check, with no idle moment in between.
      if (run === claudeSignInRun && !signedIn) { claudeSignIn = "idle"; if (!disposed) { refreshSnapshot(); emitChange(); } }
    }
    if (!signedIn) return;
    claudeSignIn = "idle";
    return runClaudeAction("connect");
  }

  /** Stops waiting on the browser. Claude Code's existing login is untouched. */
  async function cancelClaudeSignIn() {
    if (claudeSignIn === "idle") return;
    claudeSignInRun += 1;
    claudeSignIn = "idle";
    refreshSnapshot(); emitChange();
    await nativeTarget().client?.claudeCodeSignIn("cancel").catch(() => undefined);
  }

  const loadProviderAuthMethods = async () => {
    const c = options.client();
    const native = claudeAvailable();
    if (!c && !native) throw new Error(t("providers.not_connected"));
    // A read already under way (the page just opened) answers for this one.
    const nativeRead = !native ? Promise.resolve()
      : claudeBusy ? new Promise<void>((resolve) => { claudeIdleWaiters.push(resolve); })
      : runClaudeAction("read").catch(() => undefined);
    let methods: Record<string, ProviderAuthMethod[]> = {};
    let legacyError: unknown = null;
    try {
      if (c) {
        const [legacyMethods] = await Promise.all([c.provider.auth().then(unwrap), loadProviderCatalog(c)]);
        methods = buildProviderAuthMethods(legacyMethods as Record<string, ProviderAuthMethod[]>, getProviderAuthProviders());
      }
    } catch (error) {
      legacyError = error;
    }
    await nativeRead;
    // Claude Code is one of the ways to connect Anthropic, listed first.
    const offered = claudeLoginOffered();
    if (legacyError || (!c && !offered)) {
      // The engine's own sign-in list can fail on its own; Claude Code stays reachable.
      if (!offered) throw legacyError ?? new Error(t("providers.not_connected"));
      setStateField("providerAuthError", "Other provider connections could not be loaded. Close this window and retry from AI providers.");
    }
    if (offered) methods[CLAUDE_AGENT_HOST_PROVIDER_ID] = [{ type: "external", label: CLAUDE_CODE_NAME }, ...(methods[CLAUDE_AGENT_HOST_PROVIDER_ID] ?? [])];
    return methods;
  };

  async function startProviderAuth(
    providerId?: string,
    methodIndex?: number,
  ): Promise<ProviderOAuthStartResult> {
    setStateField("providerAuthError", null);
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }
    try {
      const cachedMethods = state.providerAuthMethods;
      const authMethods = Object.keys(cachedMethods).length
        ? cachedMethods
        : await loadProviderAuthMethods();
      const providerIds = Object.keys(authMethods).sort();
      if (!providerIds.length) {
        throw new Error(t("providers.no_providers_available"));
      }

      const resolved = providerId?.trim() ?? "";
      if (!resolved) {
        throw new Error(t("providers.provider_id_required"));
      }

      const methods = authMethods[resolved];
      if (!methods || !methods.length) {
        throw new Error(`${t("providers.unknown_provider")}: ${resolved}`);
      }

      const oauthIndex =
        methodIndex !== undefined
          ? methodIndex
          : methods.find((method) => method.type === "oauth")?.methodIndex ?? -1;
      if (oauthIndex === -1) {
        throw new Error(
          `${t("providers.no_oauth_prefix")} ${resolved}. ${t("providers.use_api_key_suffix")}`,
        );
      }

      const selectedMethod = methods.find((method) => method.methodIndex === oauthIndex);
      if (!selectedMethod || selectedMethod.type !== "oauth") {
        throw new Error(`${t("providers.not_oauth_flow_prefix")} ${resolved}.`);
      }

      const auth = unwrap(
        await c.provider.oauth.authorize({ providerID: resolved, method: oauthIndex }),
      );
      return { methodIndex: oauthIndex, authorization: auth };
    } catch (error) {
      const message = describeProviderError(error, t("providers.connect_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  const isIncompatiblePermissionsConfigError = (error: unknown, depth = 0): boolean => {
    if (depth > 5) return false;
    if (typeof error === "string") {
      try {
        const parsed: unknown = JSON.parse(error);
        return isIncompatiblePermissionsConfigError(parsed, depth + 1);
      } catch {
        return error.includes("V2 permissions are not supported by OpenCode V1");
      }
    }
    if (!isRecord(error)) return false;
    return isIncompatiblePermissionsConfigError(error.message, depth + 1)
      || isIncompatiblePermissionsConfigError(error.data, depth + 1)
      || (Array.isArray(error.issues) && error.issues.some(
        (issue) => isRecord(issue) && isIncompatiblePermissionsConfigError(issue.message, depth + 1),
      ));
  };

  let providerRefreshGeneration = 0;

  async function refreshProviders(
    optionsArg?: {
      dispose?: boolean;
      force?: boolean;
      /**
       * The caller just rewrote engine config (for example disabled_providers).
       * Reload even inside the 10s dispose throttle; otherwise the read below
       * returns the pre-change config and undoes the change in the UI.
       */
      configChanged?: boolean;
    },
    isCurrent = () => !disposed,
  ) {
    const c = options.client();
    if (!c || !isCurrent()) return null;
    const generation = ++providerRefreshGeneration;
    const baseUrl = options.providerBaseUrl();
    const directory = options.selectedWorkspaceRoot();
    const isRefreshCurrent = () => !disposed && isCurrent()
      && generation === providerRefreshGeneration
      && baseUrl === options.providerBaseUrl()
      && directory === options.selectedWorkspaceRoot();
    const force = Boolean(optionsArg?.dispose || optionsArg?.force || state.providerLoadState.error);
    setStateField("providerLoadState", { status: "loading", error: state.providerLoadState.error });

    const serverClient = options.openworkServer.getSnapshot().openworkServerClient;
    const liveCatalog = optionsArg?.dispose && serverClient
      ? await serverClient.getEngineV2PreviewStatus().then(status => status.enabled && status.chatRouting).catch(() => false)
      : false;
    if (optionsArg?.dispose && !liveCatalog) {
      const now = Date.now();
      const shouldDispose = Boolean(optionsArg?.configChanged)
        || now - lastGlobalProviderDisposeRefreshAt >= 10_000;
      const shouldUseServerReload = !(
        isDesktopRuntime() && options.selectedWorkspaceDisplay().workspaceType === "local"
      );
      // Prefer the OpenWork server engine reload: it disposes the engine AND
      // re-registers runtime-DB MCPs, so non-primary workspaces and pending
      // changes are picked up instead of silently dropping (toggles "turn
      // off").
      let reloaded = false;
      if (shouldDispose) {
        lastGlobalProviderDisposeRefreshAt = now;
        if (shouldUseServerReload) {
          try {
            const openworkSnapshot = options.openworkServer.getSnapshot();
            const openworkClient = openworkSnapshot.openworkServerClient;
            if (openworkSnapshot.openworkServerStatus === "connected" && openworkClient) {
              const workspaceId =
                options.runtimeWorkspaceId()?.trim() ||
                (await options.ensureRuntimeWorkspaceId?.())?.trim() ||
                "";
              if (workspaceId) {
                try {
                  await openworkClient.reloadEngine(workspaceId);
                } catch (error) {
                  const unreachable =
                    error instanceof OpenworkServerError && error.code === "opencode_engine_unreachable";
                  if (!unreachable || !isDesktopRuntime()) {
                    throw error;
                  }
                  await engineRestart({ diagnosticsCause: "provider-auth" });
                }
                reloaded = true;
              }
            }
          } catch {
            // fall back to a direct engine dispose below
          }
        }

        if (!reloaded) {
          try {
            unwrap(await c.instance.dispose());
          } catch {
            // ignore dispose failures and try reading current state anyway
          }
        }
      }

      try {
        await waitForHealthy(options.client() ?? c, { timeoutMs: 8000, pollMs: 250 });
      } catch {
        // ignore health wait failures and still attempt provider reads
      }
    }

    if (!isRefreshCurrent()) return null;
    const activeClient = options.client() ?? c;
    try {
      const disabledProviders = await readManagedDisabledProviders({
        opencodeClient: activeClient,
        openworkClient: options.openworkServer.getSnapshot().openworkServerClient,
        workspaceId: options.runtimeWorkspaceId(),
        workspaceType: options.selectedWorkspaceDisplay().workspaceType,
      });
      if (!isRefreshCurrent()) return null;
      const updated = filterProviderList(
        await ensureProviderListQuery(getReactQueryClient(), {
          client: activeClient,
          baseUrl,
          directory,
          force,
        }),
        disabledProviders,
      );
      if (!isRefreshCurrent()) return null;
      options.setDisabledProviders(disabledProviders);
      applyProviderListState(updated);
      setStateField("providerLoadState", { status: "ready", error: null });
      return updated;
    } catch (error) {
      if (isRefreshCurrent()) {
        setStateField("providerLoadState", {
          status: "error",
          error: t(isIncompatiblePermissionsConfigError(error)
            ? "settings.provider_load_incompatible_permissions"
            : "settings.provider_load_error"),
        });
      }
      return null;
    }
  }

  async function completeProviderAuthOAuth(
    providerId: string,
    methodIndex: number,
    code?: string,
  ) {
    setStateField("providerAuthError", null);
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }

    const resolved = providerId?.trim();
    if (!resolved) {
      throw new Error(t("providers.provider_id_required"));
    }

    if (!Number.isInteger(methodIndex) || methodIndex < 0) {
      throw new Error(t("providers.oauth_method_required"));
    }

    const waitForProviderConnection = async (timeoutMs = 15000, pollMs = 2000) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        try {
          const updated = await refreshProviders({ dispose: true });
          const connected = new Set(updated?.connected ?? []);
          if (connected.has(resolved)) {
            return true;
          }
        } catch {
          // ignore and retry
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      return false;
    };

    const isPendingOauthError = (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error ?? "");
      return /request timed out/i.test(text) || /ProviderAuthOauthMissing/i.test(text);
    };

    try {
      if (resolved.toLowerCase() === "opencode") {
        await ensureProjectProviderDisabledState(resolved, false);
      }
      const trimmedCode = code?.trim();
      const workspaceId = options.runtimeWorkspaceId();
      const result = await c.provider.oauth.callback({
        providerID: resolved,
        method: methodIndex,
        code: trimmedCode || undefined,
      });
      assertNoClientError(result);
      if (workspaceId) useProviderCredentialHealth.getState().changed(workspaceId, resolved);
      const updated = await refreshProviders({ dispose: true });
      const connectedNow = Array.isArray(updated?.connected) && updated.connected.includes(resolved);
      if (connectedNow) {
        return { connected: true, message: `${t("status.connected")} ${resolved}` };
      }
      const connected = await waitForProviderConnection();
      if (connected) {
        return { connected: true, message: `${t("status.connected")} ${resolved}` };
      }
      return { connected: false, pending: true };
    } catch (error) {
      if (isPendingOauthError(error)) {
        const updated = await refreshProviders({ dispose: true });
        if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
          return { connected: true, message: `${t("status.connected")} ${resolved}` };
        }
        const connected = await waitForProviderConnection();
        if (connected) {
          return { connected: true, message: `${t("status.connected")} ${resolved}` };
        }
        return { connected: false, pending: true };
      }
      const message = describeProviderError(error, t("providers.oauth_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function submitProviderApiKey(providerId: string, apiKey: string) {
    if (providerId === CLAUDE_AGENT_PROVIDER_ID) throw new Error("Claude Code uses its own sign-in, not an API key.");
    setStateField("providerAuthError", null);
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }

    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error(t("providers.api_key_required"));
    }

    setStateField("providerAuthBusy", true);
    try {
      if (providerId.trim().toLowerCase() === "opencode") {
        await ensureProjectProviderDisabledState(providerId, false);
      }
      const workspaceId = options.runtimeWorkspaceId();
      assertNoClientError(await c.auth.set({ providerID: providerId, auth: { type: "api", key: trimmed } }));
      if (workspaceId) useProviderCredentialHealth.getState().changed(workspaceId, providerId);
      await refreshProviders({ dispose: true });
      // A configured provider can already be listed before a key is saved.
      // Its connected IDs then stay identical, but its engine availability
      // changed; do not leave the old skipped-provider state cached.
      await getReactQueryClient().invalidateQueries({ queryKey: ["local-provider-engine-states"] });
      return `${t("status.connected")} ${providerId}`;
    } catch (error) {
      const message = describeProviderError(error, t("providers.save_api_key_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setStateField("providerAuthBusy", false);
    }
  }

  async function disconnectProvider(providerId: string) {
    if (providerId === CLAUDE_AGENT_PROVIDER_ID) return runClaudeAction("disconnect");
    setStateField("providerAuthError", null);
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }

    const resolved = providerId.trim();
    if (!resolved) {
      throw new Error(t("providers.provider_id_required"));
    }


    const workspaceKey = currentWorkspaceKey();
    const baseUrl = options.providerBaseUrl();
    const isCurrentWorkspace = () => !disposed
      && workspaceKey === currentWorkspaceKey()
      && baseUrl === options.providerBaseUrl();
    const requireDiscovery = (updated: ProviderListResponse | null, requireDisconnected = false) => {
      if (!isCurrentWorkspace() || !updated || !Array.isArray(updated.all) || !Array.isArray(updated.connected)
        || (requireDisconnected && updated.connected.includes(resolved))) {
        throw new Error(t("providers.disconnect_unverified"));
      }
      return updated;
    };

    try {
      // OpenCode Zen is built-in / env-backed. Credential removal alone leaves
      // it connected — disable it via runtime OPENCODE_CONFIG injection.
      if (resolved.toLowerCase() === "opencode") {
        try {
          await removeProviderAuthCredentials(resolved);
        } catch {
          // Zen may have no stored credentials; disable still applies.
        }
        if (!isCurrentWorkspace()) throw new Error(t("providers.disconnect_unverified"));
        const configChanged = await ensureProjectProviderDisabledState(resolved, true);
        requireDiscovery(await refreshProviders({ dispose: true, configChanged }, isCurrentWorkspace), true);
        removeProviderFromState(resolved);
        return `${t("providers.disconnected_prefix")} ${resolved}`;
      }

      await removeProviderAuthCredentials(resolved);
      const updated = requireDiscovery(await refreshProviders({ dispose: true }, isCurrentWorkspace));
      if (updated.connected.includes(resolved)) {
        const stillConnected = updated.all.find((provider) => provider.id === resolved);
        if (stillConnected && stillConnected.source !== "env") {
          // The provider definition lives in an opencode config file (for
          // example ~/.config/opencode/opencode.json), so credential removal
          // alone can never disconnect it. Disable it via disabled_providers,
          // exactly like the built-in OpenCode Zen branch above, instead of
          // leaving the Disconnect button a silent no-op.
          const configChanged = await ensureProjectProviderDisabledState(resolved, true);
          requireDiscovery(await refreshProviders({ dispose: true, configChanged }, isCurrentWorkspace), true);
          removeProviderFromState(resolved);
          return `${t("providers.disconnected_prefix")} ${resolved}`;
        }
        // Provider is still connected via env var. Just remove stored
        // credentials; the environment stays operator-owned, so do NOT add
        // it to disabled_providers.
        return `Removed stored credentials for ${resolved}${t("providers.still_connected_suffix")}`;
      }
      removeProviderFromState(resolved);
      return `${t("providers.disconnected_prefix")} ${resolved}`;
    } catch (error) {
      const message = describeProviderError(error, t("providers.disconnect_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /**
   * Undo a Disconnect that hid a provider through `disabled_providers` (for
   * example OpenCode Zen, which has no credentials to remove). Once hidden the
   * engine drops it from every list, so this is the only way back in the UI.
   */
  async function enableProvider(providerId: string) {
    setStateField("providerAuthError", null);
    const resolved = providerId.trim();
    if (!resolved) {
      throw new Error(t("providers.provider_id_required"));
    }
    const workspaceKey = currentWorkspaceKey();
    const baseUrl = options.providerBaseUrl();
    const isCurrentWorkspace = () => !disposed
      && workspaceKey === currentWorkspaceKey()
      && baseUrl === options.providerBaseUrl();
    try {
      const configChanged = await ensureProjectProviderDisabledState(resolved, false);
      await refreshProviders({ dispose: true, configChanged }, isCurrentWorkspace);
      return `${t("providers.enabled_prefix")} ${resolved}`;
    } catch (error) {
      const message = describeProviderError(error, t("providers.enable_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }


  async function openProviderAuthModal(optionsArg?: {
    returnFocusTarget?: ProviderReturnFocusTarget;
    preferredProviderId?: string;
  }) {


    mutateState((current) => ({
      ...current,
      providerAuthReturnFocusTarget: optionsArg?.returnFocusTarget ?? "none",
      providerAuthPreferredProviderId: optionsArg?.preferredProviderId?.trim() || null,
      providerAuthBusy: true,
      providerAuthError: null,
    }));

    try {
      const methods = await loadProviderAuthMethods();
      mutateState((current) => ({
        ...current,
        providerAuthMethods: methods,
        providerAuthModalOpen: true,
      }));
    } catch (error) {
      const message = describeProviderError(error, t("providers.load_failed"));
      if (!options.client()) {
        // No workspace engine yet: callers send the person to AI Providers.
        mutateState((current) => ({
          ...current,
          providerAuthPreferredProviderId: null,
          providerAuthReturnFocusTarget: "none",
          providerAuthError: message,
        }));
        throw error;
      }
      // The engine answered but could not list sign-in methods, for example
      // when a provider in opencode.json is missing its npm package or
      // baseURL. Open the dialog with the error so Connect never fails
      // silently and the person sees what to fix (#6283).
      mutateState((current) => ({
        ...current,
        providerAuthMethods: {},
        providerAuthPreferredProviderId: null,
        providerAuthModalOpen: true,
        providerAuthError: message,
      }));
    } finally {
      setStateField("providerAuthBusy", false);
    }
  }

  function closeProviderAuthModal(optionsArg?: { restorePromptFocus?: boolean }) {
    const shouldFocusPrompt =
      optionsArg?.restorePromptFocus ?? state.providerAuthReturnFocusTarget === "composer";
    mutateState((current) => ({
      ...current,
      providerAuthModalOpen: false,
      providerAuthError: null,
      providerAuthPreferredProviderId: null,
      providerAuthReturnFocusTarget: "none",
    }));
    if (shouldFocusPrompt) {
      options.focusPromptSoon?.();
    }
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const currentWorkspaceKey = () =>
    `${options.selectedWorkspaceRoot().trim()}::${options.runtimeWorkspaceId() ?? ""}`;
  const syncFromOptions = () => {
    if (disposed) return;
    const workspaceId = options.runtimeWorkspaceId();
    if (workspaceId && options.providerBaseUrl().trim()) useProviderCredentialHealth.getState().bindWorkspace(workspaceId, providerCredentialScope(options.providerBaseUrl()));
    if (claudeAvailable() && !claudeBusy && claudeContext !== nativeContext()) void runClaudeAction("read").catch(() => undefined);
    refreshSnapshot();
    emitChange();
  };
  const start = () => {
    if (started) return;
    disposed = false;
    started = true;
    syncFromOptions();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    started = false;
    if (claudeFollowUp) { clearTimeout(claudeFollowUp); claudeFollowUp = null; }
    for (const resolve of claudeIdleWaiters.splice(0)) resolve();
    claudeSignInRun += 1;
    listeners.clear();
  };

  refreshSnapshot();

  return {
    subscribe,
    getSnapshot: () => snapshot,
    start,
    dispose,
    syncFromOptions,
    startProviderAuth,
    connectClaudeAgent: () => runClaudeAction("connect"),
    signInClaudeAgent: () => signInWithClaudeCode(),
    cancelClaudeAgentSignIn: () => cancelClaudeSignIn(),
    checkClaudeAgentInstalled: () => checkClaudeInstalled(),
    refreshProviders,
    completeProviderAuthOAuth,
    submitProviderApiKey,
    disconnectProvider,
    enableProvider,
    ensureProjectProviderDisabledState,
    openProviderAuthModal,
    closeProviderAuthModal,
  };
}

export function useProviderAuthStoreSnapshot(store: ProviderAuthStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
