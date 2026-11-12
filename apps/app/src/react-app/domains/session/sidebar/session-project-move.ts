import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { useSessionManagementStore } from "./session-management-store";

/** Every human move waits for the server result; failed migrations leave the cached project intact. */
export function requestSessionGroupMove(workspaceId: string, sessionId: string, groupId: string | null): void {
  void useSessionManagementStore.getState().assignGroup(workspaceId, sessionId, groupId).catch((error: unknown) => {
    toast.error(t("session.project_move_failed"), { description: error instanceof Error ? error.message : String(error) });
  });
}
