export type SessionSubmissionResult =
  | { outcome: "sent"; bypassed: boolean }
  | { outcome: "accepted" }
  | { outcome: "blocked"; issue: { message: string } }
  | { outcome: "cancelled"; reason: "context_changed" | "unmounted" };

export async function submitSessionDraft(input: { send: () => Promise<unknown>; skipGate?: boolean }): Promise<SessionSubmissionResult> {
  await input.send();
  return { outcome: "sent", bypassed: false };
}
