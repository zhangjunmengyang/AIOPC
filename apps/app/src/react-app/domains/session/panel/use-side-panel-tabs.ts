import { EnvironmentPicker } from "../../aiopc/environment-picker";
import * as React from "react";

import { t } from "@/i18n";

import {
  type PanelTab,
  usePanelTabStore,
} from "./panel-tab-store";

/** One tab per environment, so a project's independent accounts never share a viewer. */
export function environmentTab(environmentId: string, workspaceRoot: string, label?: string): PanelTab {
  return { id: `environment:${environmentId}`, type: "environment", label: label ?? t("aiopc.browser.live_view"), workspaceRoot, environmentId };
}

export function useSidePanelTabs(sessionId: string) {
  const closeTab = useCloseTab();
  const selectTab = useSelectTab();
  const reorderTabs = useReorderTabs();

  return {
    closeTab: (tab: PanelTab) => closeTab(sessionId, tab),
    selectTab: (tabId: string) => selectTab(sessionId, tabId),
    reorderTabs: (tabIds: string[]) => reorderTabs(sessionId, tabIds),
  };
}

/** The rail button beside the chat: shows the project environment, or hides it when it is already showing. */
export function useOpenEnvironmentPane(
  sessionId: string,
  workspaceRoot: string,
  active: boolean,
  setPanel: (panel: "panel" | null) => void,
) {
  const [choosing, setChoosing] = React.useState(false);
  const open = React.useCallback(() => {
    if (active) { setPanel(null); return; }
    if (workspaceRoot) setChoosing(true);
  }, [active, setPanel, workspaceRoot]);
  const picker = choosing ? React.createElement(EnvironmentPicker, { projectRoot: workspaceRoot, onClose: () => setChoosing(false), onSelect: environment => {
    usePanelTabStore.getState().openTab(sessionId, environmentTab(environment.id, environment.boundProject ?? workspaceRoot, environment.name));
    setChoosing(false); setPanel("panel");
  } }) : null;
  return { open, picker };
}

export function useCloseTab() {
  const closeTab = usePanelTabStore((state) => state.closeTab);
  return React.useCallback((sessionId: string, tab: PanelTab) => closeTab(sessionId, tab.id), [closeTab]);
}

export function useSelectTab() {
  const selectTab = usePanelTabStore((state) => state.selectTab);

  return React.useCallback((sessionId: string, tabId: string) => {
    const tabs = usePanelTabStore.getState().sessions[sessionId]?.tabs ?? [];
    if (tabs.some((entry) => entry.id === tabId)) selectTab(sessionId, tabId);
  }, [selectTab]);
}

export function useReorderTabs() {
  const reorderTabs = usePanelTabStore((state) => state.reorderTabs);
  return React.useCallback((sessionId: string, tabIds: string[]) => reorderTabs(sessionId, tabIds), [reorderTabs]);
}
