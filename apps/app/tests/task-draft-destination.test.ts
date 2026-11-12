import { expect, test } from "bun:test";
import {
  carryDraftTask, newSessionDestinationFromSearch, newSessionDraftSlot, openNewSessionDraft,
} from "../src/react-app/domains/session/chat/new-session-destination";

test("task drafts have distinct slots and round-trip through the project chat route", () => {
  const project = { workspaceId: "company", groupId: "proj:launch" };
  const first = { ...project, taskId: "first" };
  const second = { ...project, taskId: "second" };
  expect(newSessionDraftSlot(first)).not.toBe(newSessionDraftSlot(second));
  expect(newSessionDraftSlot(first)).not.toBe(newSessionDraftSlot(project));
  let navigated = "";
  openNewSessionDraft(first, (route) => { navigated = route; });
  const url = new URL(navigated, "http://localhost");
  expect(url.pathname).toBe("/workspace/company/session");
  expect(newSessionDestinationFromSearch("company", url.search)).toEqual(first);
  expect(newSessionDestinationFromSearch("company", "?draftGroup=custom&draftTask=first").taskId).toBeUndefined();
});

test("changing a draft's project drops the previous project's task", () => {
  const source = { workspaceId: "company", groupId: "proj:launch", taskId: "first" };
  expect(carryDraftTask(source, { workspaceId: "company", groupId: "proj:launch" })).toEqual(source);
  expect(carryDraftTask(source, { ...source, groupId: "proj:other" })).toEqual({ workspaceId: "company", groupId: "proj:other" });
  expect(carryDraftTask(source, { ...source, workspaceId: "other-company" })).toEqual({ workspaceId: "other-company", groupId: "proj:launch" });
});
