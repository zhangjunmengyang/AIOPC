import { workspaceSessionRoute } from "@/react-app/shell/workspace-routes";
import { NEW_TASK_DRAFT_SESSION_ID, sessionDraftScopeKey } from "../sync/draft-store";
import { useWorkbenchStore, workbenchSessionKey, type WorkbenchSessionTab } from "./workbench-store";
import type { ComposerSessionState } from "../surface/composer-state-store";
import { encodeComposerMentionValue } from "../surface/composer/mention-encoding";

export type NewSessionDestination = {
  workspaceId: string;
  groupId?: string;
  taskId?: string;
  parent?: WorkbenchSessionTab;
};

export function newSessionDraftSlot(destination: NewSessionDestination): string {
  if (!destination.groupId && !destination.parent && !destination.taskId) return NEW_TASK_DRAFT_SESSION_ID;
  const parts = [destination.groupId ?? null, destination.parent?.sessionId ?? null];
  if (destination.taskId) parts.push(destination.taskId);
  return `${NEW_TASK_DRAFT_SESSION_ID}${JSON.stringify(parts)}`;
}

export function newSessionDraftOwnerKey(scope: string | null | undefined, destination: NewSessionDestination) {
  return sessionDraftScopeKey(scope, destination.workspaceId, newSessionDraftSlot(destination));
}

/** Attached or mentioned workspace files tie a draft to its workspace. */
export function draftHasWorkspaceFiles(state: Pick<ComposerSessionState, "attachments" | "draft" | "mentions">) {
  const hasFileMentions = Object.entries(state.mentions).some(([value, kind]) => kind === "file" && state.draft.includes(`@${encodeComposerMentionValue(value)}`));
  return state.attachments.length > 0 || hasFileMentions || /file:\/\//i.test(state.draft);
}

export function draftWorkspaceChangeBlocked(source: string, destination: string, state: ComposerSessionState) {
  if (source === destination) return false;
  return draftHasWorkspaceFiles(state);
}

export function newSessionDestinationFromSearch(workspaceId: string, search: string): NewSessionDestination {
  const params = new URLSearchParams(search);
  const groupId = params.get("draftGroup") || undefined;
  const taskId = groupId?.startsWith("proj:") ? params.get("draftTask") : null;
  return { workspaceId, groupId, ...(taskId ? { taskId } : {}) };
}

export function carryDraftTask(source: NewSessionDestination, target: NewSessionDestination): NewSessionDestination {
  const { taskId: _discarded, ...destination } = target;
  return source.taskId && source.workspaceId === target.workspaceId && source.groupId === target.groupId
    ? { ...destination, taskId: source.taskId }
    : destination;
}

/** One navigation-only command for every New session entry point. */
export function openNewSessionDraft(destination: NewSessionDestination, navigate: (path: string) => void) {
  const workbench = useWorkbenchStore.getState();
  if (destination.parent) {
    const existing = workbench.sideChats[workbenchSessionKey(destination.parent)];
    const tab = existing ?? {
      workspaceId: destination.parent.workspaceId,
      workspaceTitle: destination.parent.workspaceTitle,
      sessionId: newSessionDraftSlot(destination),
      title: "Draft",
      draftDestination: destination,
    };
    workbench.openTab(tab);
    workbench.setSideChat(destination.parent, tab);
    return;
  }
  workbench.focusPane("primary");
  const query = new URLSearchParams();
  if (destination.groupId) query.set("draftGroup", destination.groupId);
  if (destination.taskId) query.set("draftTask", destination.taskId);
  navigate(`${workspaceSessionRoute(destination.workspaceId)}${query.size ? `?${query}` : ""}`);
}
