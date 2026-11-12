import * as React from "react";

import { t } from "@/i18n";

import {
  type PanelTab,
  usePanelTabStore,
} from "./panel-tab-store";

/** The project environment's picture, as a panel tab: one per project, reopened rather than duplicated. */
export function environmentTab(workspaceRoot: string): PanelTab {
  return { id: `environment:${workspaceRoot}`, type: "environment", label: t("aiopc.browser.live_view"), workspaceRoot };
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
  return React.useCallback(() => {
    if (active) {
      setPanel(null);
      return;
    }
    if (workspaceRoot) usePanelTabStore.getState().openTab(sessionId, environmentTab(workspaceRoot));
    setPanel("panel");
  }, [active, sessionId, setPanel, workspaceRoot]);
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
