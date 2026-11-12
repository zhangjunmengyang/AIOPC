/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { evalRelaunchDesktopApp } from "@/app/lib/desktop";
import { isDesktopRuntime, isElectronRuntime } from "@/app/lib/runtime-env";
import { ComputerBridge } from "../domains/session/computer/computer-store";
import { AgentQuestionsBridge } from "../domains/session/status/agent-questions-bridge";
import { ChatDeepLinkListener } from "./chat-deep-link-listener";
import { NewProvidersListener } from "./new-providers-listener";
import { useDesktopFontZoomBehavior } from "./font-zoom";
import { LoadingOverlay } from "./loading-overlay";
import { useVisualViewportInset } from "@/hooks/use-visual-viewport-inset";
import { DevProfiler, DevProfilerOverlay } from "./dev-profiler";
import { ReactRenderWatchdogOverlay } from "./react-render-watchdog-overlay";
import { EngineSwitchOverlay } from "./engine-switch";
import { useEngineRouting } from "./use-engine-routing";
import { AppMenuProvider } from "./app-menu";
import { OpenworkControlProvider, OpenworkRouteControlActions, useControlAction, type OpenworkControlAction } from "./control/control-provider";
import { OpenworkContextPublisher } from "./openwork-context-publisher";
import { SessionRoute } from "./session-route";
import { DesktopUpdaterProvider } from "../domains/settings/state/desktop-updater-provider";
import { SettingsRoute } from "./settings-route";
import { ShellConfigProvider } from "./shell-config";
import { WelcomeRoute } from "./welcome-route";

function DevControlActions() {
  const relaunchAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.app.relaunch",
      label: "Relaunch app for eval",
      description: "Dev-only eval hook that relaunches the Electron app.",
      sideEffect: "mutation",
      execute: () => evalRelaunchDesktopApp(),
    };
  }, []);
  useControlAction(relaunchAction);

  const [renderThrow, setRenderThrow] = useState<string | null>(null);
  const renderThrowAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.app.render_throw",
      label: "Throw during render for eval",
      description: "Dev-only eval hook that throws during React render so the app-level recovery screen can be exercised.",
      sideEffect: "mutation",
      requiresArgs: true,
      args: [{ name: "message", type: "string", required: true, description: "Error message to throw." }],
      execute: (args) => {
        if (typeof args !== "object" || args === null || !("message" in args) || typeof args.message !== "string") {
          return { ok: false, error: "message is required" };
        }
        setRenderThrow(args.message);
        return undefined;
      },
    };
  }, []);
  useControlAction(renderThrowAction);
  if (renderThrow) throw new Error(renderThrow);

  return null;
}

export function AppRoot() {
  useDesktopFontZoomBehavior();
  useVisualViewportInset();
  useEngineRouting();
  return <>
    <DevProfiler id="AppRoot">
      <DesktopUpdaterProvider>
        <ShellConfigProvider>
          <AppMenuProvider>
            <OpenworkControlProvider>
              <OpenworkRouteControlActions />
              <ChatDeepLinkListener />
              <OpenworkContextPublisher />
              <DevControlActions />
              {isElectronRuntime() ? <ComputerBridge /> : null}
              {isElectronRuntime() ? <AgentQuestionsBridge /> : null}
              <Routes>
                <Route path="/welcome" element={isDesktopRuntime() ? <Navigate to="/session" replace /> : <WelcomeRoute />} />
                <Route path="/session" element={<SessionRoute />} />
                <Route path="/session/:sessionId" element={<SessionRoute />} />
                <Route path="/workspace/:workspaceId/session" element={<SessionRoute />} />
                <Route path="/workspace/:workspaceId/session/:sessionId" element={<SessionRoute />} />

                <Route path="/workspace/:workspaceId/projects/:projectName?" element={<SessionRoute />} />
                <Route path="/space" element={<SessionRoute />} />
                <Route path="/accounts" element={<SessionRoute />} />
                <Route path="/workspace/:workspaceId/extensions/*" element={<SessionRoute />} />
                <Route path="/extensions/*" element={<SessionRoute />} />
                <Route path="/workspace/:workspaceId/settings/*" element={<SettingsRoute />} />
                <Route path="/settings/*" element={<SettingsRoute />} />
                <Route path="*" element={<Navigate to="/session" replace />} />
              </Routes>
              <LoadingOverlay />
              <EngineSwitchOverlay />
            </OpenworkControlProvider>
          </AppMenuProvider>
        </ShellConfigProvider>
      </DesktopUpdaterProvider>
    </DevProfiler>
    <NewProvidersListener />
    <DevProfilerOverlay />
    <ReactRenderWatchdogOverlay />
  </>;
}
