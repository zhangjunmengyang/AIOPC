import { beforeEach, expect, test } from "bun:test";
import { beginPendingConversation, createPendingConversation, ensurePendingConversationContext, usePendingConversationStore } from "../src/react-app/domains/session/chat/pending-conversation-store";

beforeEach(() => usePendingConversationStore.setState({ conversations: {} }));
test("first send persists its captured project and role before sending, and retries metadata without recreating the session", async () => {
  const pending = beginPendingConversation({ scope: "local", destination: { workspaceId: "company", groupId: "proj:A" }, agentName: "writer",
    submitted: { draft: "write", attachments: [], mentions: {}, pasteParts: [], revertMessageId: null } });
  let creates = 0;
  await createPendingConversation(pending.id, async () => { creates += 1; return { session: { id: "session" } as never }; }, () => {});
  const calls: string[] = [];
  let offline = true;
  const assign = async (_workspace: string, _session: string, group: string) => { calls.push(group); };
  const saveRole = async (_workspace: string, _session: string, role: string | null) => { calls.push(role ?? "default"); if (offline) throw new Error("offline"); };
  await expect(ensurePendingConversationContext("local", "company", "session", assign, saveRole)).rejects.toThrow("offline");
  offline = false;
  expect(await ensurePendingConversationContext("local", "company", "session", assign, saveRole)).toEqual({ agentName: "writer" });
  expect(calls).toEqual(["proj:A", "writer", "writer"]);
  expect(creates).toBe(1);
  expect(await ensurePendingConversationContext("local", "company", "session", assign, saveRole)).toBeUndefined();
});
