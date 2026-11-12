import type { NewTaskComposerContext } from "./new-task-composer";
import type { SessionPagePaneRuntime } from "./session-page";

/** A side draft shares composer choices, but all file/skill/role discovery uses its own project. */
export function scopeNewTaskComposer(context: NewTaskComposerContext, runtime: Extract<SessionPagePaneRuntime, { status: "ready" }>): NewTaskComposerContext {
  return { ...context, client: runtime.client, workspaceId: runtime.runtimeWorkspaceId,
    executionDirectory: runtime.workspaceRoot, listAgents: runtime.surface.listAgents,
    listCommands: runtime.surface.listCommands, searchFiles: runtime.surface.searchFiles };
}
