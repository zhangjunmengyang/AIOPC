import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { useSessionManagementStore } from "../sidebar/session-management-store";

const STORAGE_KEY = "openwork.sessionAgents.v1";
const MAX_REMEMBERED_SESSIONS = 200;

type SessionAgentSelections = Record<string, string | null>;

function capSelections(selections: SessionAgentSelections): SessionAgentSelections {
  return Object.fromEntries(Object.entries(selections).slice(-MAX_REMEMBERED_SESSIONS));
}

export function readSessionAgentSelections(): SessionAgentSelections {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries: [string, string | null][] = [];
    for (const [sessionId, value] of Object.entries(parsed)) {
      const agent: unknown = value;
      if (!sessionId.trim() || (agent !== null && (typeof agent !== "string" || !agent.trim()))) continue;
      entries.push([sessionId, agent]);
    }
    return Object.fromEntries(entries.slice(-MAX_REMEMBERED_SESSIONS));
  } catch {
    return {};
  }
}

type SessionAgentStore = {
  bySessionId: SessionAgentSelections;
  setAgent: (sessionId: string, agent: string | null) => void;
};

export const useSessionAgentStore = create<SessionAgentStore>((set) => ({
  bySessionId: readSessionAgentSelections(),
  setAgent: (sessionId, agent) => set((state) => {
    if (!sessionId.trim()) return state;
    if (Object.hasOwn(state.bySessionId, sessionId) && state.bySessionId[sessionId] === agent) return state;
    const { [sessionId]: _replaced, ...rest } = state.bySessionId;
    const bySessionId = capSelections({ ...rest, [sessionId]: agent });
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bySessionId));
    } catch {
      // Keep the in-memory choice when storage is unavailable.
    }
    return { bySessionId };
  }),
}));

export function getSessionAgentSelection(sessionId: string, fallbackAgent: string | null = null, workspaceId?: string): string | null {
  const state = useSessionManagementStore.getState();
  const metadata = workspaceId ? state.groupsByWorkspace[workspaceId]?.sessionMeta?.[sessionId] : undefined;
  if (metadata) return metadata.agentName ?? null;
  if (workspaceId && state.serverSyncedWorkspaces[workspaceId]) return null;
  const selections = useSessionAgentStore.getState().bySessionId;
  return Object.hasOwn(selections, sessionId) ? selections[sessionId] : fallbackAgent;
}

export function useSessionAgentSelection(input: {
  workspaceId: string;
  sessionId: string | null;
  fallbackAgent: string | null;
  onFallbackAgentChange: (agent: string | null) => void;
}) {
  const { workspaceId, sessionId, fallbackAgent, onFallbackAgentChange } = input;
  const metadata = useSessionManagementStore((state) => sessionId
    ? state.groupsByWorkspace[workspaceId]?.sessionMeta?.[sessionId] : undefined);
  const serverLoaded = useSessionManagementStore((state) => Boolean(state.serverSyncedWorkspaces[workspaceId]));
  const selection = useSessionAgentStore((state) => sessionId && Object.hasOwn(state.bySessionId, sessionId)
    ? state.bySessionId[sessionId]
    : undefined);
  // Server metadata is authoritative; local storage only caches its last known value.
  useEffect(() => {
    if (sessionId && (metadata || serverLoaded)) useSessionAgentStore.getState().setAgent(sessionId, metadata?.agentName ?? null);
  }, [metadata, serverLoaded, sessionId]);
  const setAgent = useCallback((agent: string | null) => {
    if (sessionId) {
      void useSessionManagementStore.getState().setSessionAgent(workspaceId, sessionId, agent).catch((error: unknown) => {
        toast.error(t("session.role_save_failed"), { description: error instanceof Error ? error.message : String(error) });
      });
    }
    else onFallbackAgentChange(agent);
  }, [onFallbackAgentChange, sessionId, workspaceId]);
  return { selectedAgent: metadata ? metadata.agentName ?? null : sessionId && serverLoaded ? null : selection === undefined ? fallbackAgent : selection, setAgent };
}
