import { beforeEach, expect, test } from "bun:test";
import {
  beginPendingConversation, createPendingConversation, ensurePendingConversationContext, usePendingConversationStore,
} from "../src/react-app/domains/session/chat/pending-conversation-store";

beforeEach(() => usePendingConversationStore.setState({ conversations: {} }));

test("task-created draft binds the real session before sending and retries a failed bind without recreating", async () => {
  const pending = beginPendingConversation({
    scope: "local", destination: { workspaceId: "company", groupId: "proj:launch", taskId: "draft-copy" }, agentName: "writer",
    submitted: { draft: "prepare copy", attachments: [], mentions: {}, pasteParts: [], revertMessageId: null },
  });
  let creates = 0;
  await createPendingConversation(pending.id, async () => {
    creates += 1;
    return { session: { id: "ses_task" } as never };
  }, () => {});
  const calls: string[] = [];
  let offline = true;
  const assign = async (_workspace: string, _session: string, group: string) => { calls.push(group); };
  const role = async (_workspace: string, _session: string, agent: string | null) => { calls.push(agent ?? "default"); };
  const attach = async (workspace: string, session: string, task: string) => {
    calls.push(`${workspace}/${session}/${task}`);
    if (offline) throw new Error("offline");
  };
  const ensure = () => ensurePendingConversationContext("local", "company", "ses_task", assign, role, attach);
  await expect(ensure()).rejects.toThrow("offline");
  offline = false;
  expect(await ensure()).toEqual({ agentName: "writer" });
  expect(await ensure()).toBeUndefined();
  expect(calls).toEqual(["proj:launch", "company/ses_task/draft-copy", "company/ses_task/draft-copy", "writer"]);
  expect(creates).toBe(1);
});
