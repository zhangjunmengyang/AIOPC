/** @jsxImportSource react */
import { useCallback,useEffect,useReducer,useState } from "react";
import { useNavigate } from "react-router";

import { captureAnalyticsEvent } from "../../app/lib/analytics";
import {
pickDirectory,
resolveWorkspaceListSelectedId,
workspaceSetRuntimeActive,
workspaceSetSelected,
type WorkspaceInfo,
type WorkspaceList,
} from "../../app/lib/desktop";
import { createClient,unwrap } from "../../app/lib/opencode";
import { buildOpenworkWorkspaceBaseUrl,createOpenworkServerClient } from "../../app/lib/openwork-server";
import { canCreateWorkspaces } from "../../app/lib/workspace-creation-policy";
import { isDesktopRuntime } from "../../app/utils";
import { t } from "../../i18n";
import { AttributionStep,type AttributionSource } from "../domains/onboarding/attribution-step";
import { ProviderSelectionStep } from "../domains/onboarding/provider-selection-step";
import { WelcomePage } from "../domains/onboarding/welcome-page";
import { CreateWorkspaceModal } from "../domains/workspace/create-workspace-modal";
import type { CreateWorkspaceOptions } from "../domains/workspace/types";
import { useLocal } from "../kernel/local-provider";
import { usePlatform } from "../kernel/platform";
import { ensureDesktopLocalOpenworkConnection } from "./desktop-local-openwork";
import { resolveOpenworkConnection } from "./openwork-connection";
import { writeActiveWorkspaceId,writeLastSessionFor,writeWorkspaceProjectDimension } from "./session-memory";
import { workspaceSessionRoute } from "./workspace-routes";

function folderNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
}

function focusPromptSoon() {
  if (typeof window === "undefined") return;
  const focus = () => window.dispatchEvent(new Event("openwork:focusPrompt"));
  [0, 80, 240, 600].forEach((delay) => window.setTimeout(focus, delay));
}

type WelcomeState = {
  modalOpen: boolean;
  createBusy: boolean;
  createError: string | null;
  providerStep: boolean;
  attributionStep: boolean;
  pendingRoute: string | null;
  pendingWorkspaceId: string | null;
  pendingSessionId: string | null;
};

type WelcomeAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "create:start" }
  | { type: "create:error"; error: string }
  | { type: "create:finish" }
  | { type: "provider-step"; workspaceId: string; sessionId: string | null }
  | { type: "attribution-step"; route: string };

const initialWelcomeState: WelcomeState = {
  modalOpen: false,
  createBusy: false,
  createError: null,
  providerStep: false,
  attributionStep: false,
  pendingRoute: null,
  pendingWorkspaceId: null,
  pendingSessionId: null,
};

function welcomeReducer(state: WelcomeState, action: WelcomeAction): WelcomeState {
  switch (action.type) {
    case "open":
      return { ...state, modalOpen: true };
    case "close":
      return { ...state, modalOpen: false, createError: null };
    case "create:start":
      return { ...state, createBusy: true, createError: null };
    case "create:error":
      return { ...state, createError: action.error };
    case "create:finish":
      return { ...state, createBusy: false };
    case "provider-step":
      return { ...state, providerStep: true, pendingWorkspaceId: action.workspaceId, pendingSessionId: action.sessionId };
    case "attribution-step":
      return { ...state, providerStep: false, attributionStep: true, pendingRoute: action.route };
  }
}

/**
 * WelcomeRoute: full-screen welcome page shown on first launch when
 * the user has no workspaces and has not completed onboarding.
 *
 * Clicking "Get started" opens the CreateWorkspaceModal. Once a
 * workspace is created, provider and attribution onboarding runs before
 * hasCompletedOnboarding is set and the user is redirected to /session.
 */
export function WelcomeRoute() {
  const navigate = useNavigate();
  const local = useLocal();
  const platform = usePlatform();
  const [state, dispatch] = useReducer(welcomeReducer, initialWelcomeState);
  const [manualFolder, setManualFolder] = useState("");

  // If user already completed onboarding, redirect away immediately.
  useEffect(() => {
    if (local.prefs.hasCompletedOnboarding) {
      navigate("/session", { replace: true });
    }
  }, [local.prefs.hasCompletedOnboarding, navigate]);

  const markOnboardingComplete = useCallback(() => {
    local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true }));
  }, [local]);

  const handleCreateWorkspace = useCallback(
    async (_preset: string, folder: string | null, options?: CreateWorkspaceOptions) => {
      if (!folder) return;
      const projectLabel = options?.projectLabel?.trim() ?? "";
      dispatch({ type: "create:start" });
      try {
        const workspaceName = folderNameFromPath(folder);
        let list: WorkspaceList | null = null;
        let sessionBaseUrl = "";
        let sessionToken = "";
        try {
          const { normalizedBaseUrl, resolvedToken, resolvedHostToken } =
            await resolveOpenworkConnection();
          if (normalizedBaseUrl && (resolvedToken || resolvedHostToken)) {
            const openworkClient = createOpenworkServerClient({
              baseUrl: normalizedBaseUrl,
              token: resolvedToken || undefined,
              hostToken: resolvedHostToken || undefined,
            });
            list = await openworkClient.createLocalWorkspace({
              folderPath: folder,
              name: workspaceName,
              preset: "starter",
            });
            sessionBaseUrl = normalizedBaseUrl;
            sessionToken = resolvedToken;
          }
        } catch {
          list = null;
        }
        if (!list) {
          throw new Error("OpenWork server is unavailable. Start or reconnect the server before creating a workspace.");
        }
        const createdId =
          resolveWorkspaceListSelectedId(list) ||
          list.workspaces[list.workspaces.length - 1]?.id ||
          "";
        let targetWorkspaceId = createdId;
        let targetWorkspace = list.workspaces.find((workspace: WorkspaceInfo) => workspace.id === createdId) ?? null;
        let targetSessionId: string | null = null;
        if (createdId) {
          await workspaceSetSelected(createdId).catch(() => undefined);
          await workspaceSetRuntimeActive(createdId).catch(() => undefined);
          writeActiveWorkspaceId(createdId);
        }
        if (targetWorkspace) {
          await ensureDesktopLocalOpenworkConnection({
            route: "session",
            workspace: targetWorkspace,
            allWorkspaces: list.workspaces,
          }).catch(() => undefined);
          const fresh = await resolveOpenworkConnection().catch(() => null);
          if (fresh?.normalizedBaseUrl && fresh.resolvedToken) {
            sessionBaseUrl = fresh.normalizedBaseUrl;
            sessionToken = fresh.resolvedToken;
          }
        }
        if (targetWorkspaceId && sessionBaseUrl && sessionToken) {
          try {
            const workspacePath = targetWorkspace?.path?.trim() || folder;
            const session = unwrap(await createClient(
              `${(buildOpenworkWorkspaceBaseUrl(sessionBaseUrl, targetWorkspaceId) ?? sessionBaseUrl).replace(/\/+$/, "")}/opencode`,
              workspacePath || undefined,
              { token: sessionToken, mode: "openwork" },
            ).session.create({ directory: workspacePath || undefined }));
            targetSessionId = session.id;
            captureAnalyticsEvent("task_created", { source: "onboarding", workspace_type: "local" });
          } catch {
            // Best-effort first task creation.
          }
        }
        if (targetWorkspaceId) {
          writeActiveWorkspaceId(targetWorkspaceId);
          if (projectLabel) {
            writeWorkspaceProjectDimension(targetWorkspaceId, {
              label: projectLabel,
            });
          }
          if (targetSessionId) writeLastSessionFor(targetWorkspaceId, targetSessionId);
        }
        dispatch({ type: "close" });
        // Show the provider selection step before navigating to the session.
        dispatch({ type: "provider-step", workspaceId: targetWorkspaceId, sessionId: targetSessionId });

      } catch (error) {
        dispatch({
          type: "create:error",
          error: error instanceof Error ? error.message : "Failed to create workspace.",
        });
      } finally {
        dispatch({ type: "create:finish" });
      }
    },
    [],
  );

  const handleGetStarted = useCallback(async () => {
    if (!isDesktopRuntime()) {
      if (!canCreateWorkspaces()) return;
      dispatch({ type: "open" });
      return;
    }
    const picked = await pickDirectory({ title: t("onboarding.authorize_folder") });
    const folder = typeof picked === "string" ? picked : null;
    if (!folder) return;
    await handleCreateWorkspace("starter", folder);
  }, [handleCreateWorkspace]);

  const handleUseManualFolder = useCallback(async () => {
    const folder = manualFolder.trim();
    if (!folder) return;
    await handleCreateWorkspace("starter", folder);
  }, [handleCreateWorkspace, manualFolder]);

  const finishOnboarding = useCallback(() => {
    markOnboardingComplete();
    navigate(state.pendingRoute ?? "/session", { replace: true });
    if (state.pendingSessionId) focusPromptSoon();
  }, [markOnboardingComplete, navigate, state.pendingRoute, state.pendingSessionId]);

  const handleAttributionSubmit = useCallback(
    (source: AttributionSource, aiPrompt?: string) => {
      const prompt = aiPrompt?.trim().slice(0, 500) ?? "";
      captureAnalyticsEvent("attribution_survey_submitted", {
        source,
        // User-volunteered survey answer (not session content); see survey UI.
        ai_prompt: prompt || null,
        ai_prompt_length: prompt.length,
      });
      finishOnboarding();
    },
    [finishOnboarding],
  );

  const handleAttributionSkip = useCallback(() => {
    captureAnalyticsEvent("attribution_survey_skipped");
    finishOnboarding();
  }, [finishOnboarding]);

  return (
    <>
      <WelcomePage
        onGetStarted={handleGetStarted}
        busy={state.createBusy}
        error={state.createError}
        manualFolder={manualFolder}
        onManualFolderChange={setManualFolder}
        onUseManualFolder={handleUseManualFolder}
        showManualFolder={import.meta.env.DEV && isDesktopRuntime()}
      />

      <CreateWorkspaceModal
        open={state.modalOpen}
        onClose={() => dispatch({ type: "close" })}
        onConfirm={handleCreateWorkspace}
        onPickFolder={() =>
          pickDirectory({ title: t("onboarding.authorize_folder") }) as Promise<
            string | null
          >
        }
        submitting={state.createBusy}
        localError={state.createError}
        localDisabled={!isDesktopRuntime()}
        localDisabledReason={
          isDesktopRuntime()
            ? undefined
            : t("app.local_disabled_reason")
        }
      />
      {state.providerStep ? (
        <ProviderSelectionStep
          onBringYourOwn={() => {
            const route = state.pendingWorkspaceId
              ? workspaceSessionRoute(state.pendingWorkspaceId, state.pendingSessionId)
              : "/session";
            dispatch({ type: "attribution-step", route: `${route}?onboarding=1` });
          }}
          onSkip={() => {
            const route = state.pendingWorkspaceId
              ? workspaceSessionRoute(state.pendingWorkspaceId, state.pendingSessionId)
              : "/session";
            dispatch({ type: "attribution-step", route });
          }}
        />
      ) : null}
      {state.attributionStep ? (
        <AttributionStep
          onSubmit={handleAttributionSubmit}
          onSkip={handleAttributionSkip}
        />
      ) : null}
    </>
  );
}
