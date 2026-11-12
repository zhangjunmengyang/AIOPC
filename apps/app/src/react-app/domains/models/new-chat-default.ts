import type { ModelRef } from "@/app/types";

export function newChatDefaultModel(input: {
  workspaceDefault: { model: ModelRef; variant: string | null } | null;
  appDefault: { model: ModelRef | null; variant: string | null };
}): { model: ModelRef | null; variant: string | null } {
  if (input.workspaceDefault) return input.workspaceDefault;
  return input.appDefault;
}
