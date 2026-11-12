/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart } from "ai";

import type { McpAppOrigin } from "../src/components/chat/mcp-app-origin";
import { PublishReviewCard, readPublishReviewPart, submitPublishReview } from "../src/react-app/domains/aiopc/publish-review-card";

const review = {
  id: "a".repeat(32), digest: "b".repeat(64), created_at: 1780000000, sessionId: "ses_origin",
  project: "/company/projects/demo", status: "awaiting_approval" as const, platform: "X", account: "@demo",
  payload: { title: "Launch", text: "Exact preview", form: "post", account_id: "demo", media: [], tags: ["launch"] },
};
const resourceUri = "ui://aiopc/publish-review";
const part: DynamicToolUIPart = {
  type: "dynamic-tool", toolCallId: "call_review", toolName: "aiopc_social_publish", state: "output-available", input: {}, output: {},
  callProviderMetadata: { openwork: { mcpResult: { content: [], structuredContent: review } } },
};

test("the native publish card uses the frozen result and gives terminal reviews no approval controls", () => {
  expect(readPublishReviewPart(part)?.review).toEqual(review);
  expect(readPublishReviewPart({ ...part, toolName: "other_social_publish" })).toBeNull();
  expect(readPublishReviewPart({ ...part, callProviderMetadata: undefined, output: review })).toBeNull();
  const html = renderToStaticMarkup(<PublishReviewCard review={{ ...review, status: "composer_filled" }} origin={null} />);
  expect(html).toContain("Exact preview");
  expect(html).toContain("Composer filled");
  expect(html).not.toContain("Approve and fill composer");
});

test("a review decision uses only the originating session's verified App lease and frozen revision", async () => {
  const resolveMcpApp = mock(async () => ({ app: { launchId: "lease", serverName: "aiopc", toolName: "social_publish", resourceUri } }));
  const callMcpAppTool = mock(async () => ({ content: [], structuredContent: { status: "rejected" } }));
  const releaseMcpApp = mock(async () => ({ released: true }));
  const origin = { client: { resolveMcpApp, callMcpAppTool, releaseMcpApp }, workspaceId: "company", sessionId: "ses_origin", readOnly: false, engine: "v2" } as unknown as McpAppOrigin;

  await expect(submitPublishReview({ ...origin, sessionId: "ses_other" }, review, "approve")).rejects.toThrow();
  await expect(submitPublishReview({ ...origin, readOnly: true }, review, "approve")).rejects.toThrow();
  expect(resolveMcpApp).not.toHaveBeenCalled();
  expect(callMcpAppTool).not.toHaveBeenCalled();
  expect(await submitPublishReview(origin, review, "reject")).toBe("rejected");
  expect(resolveMcpApp.mock.calls[0]).toEqual(["company", "aiopc_social_publish", undefined, { sessionId: "ses_origin", readOnly: false, engine: "v2" }]);
  expect(callMcpAppTool.mock.calls[0]?.slice(0, 2)).toEqual(["company", {
    launchId: "lease", sessionId: "ses_origin", engine: "v2", serverName: "aiopc", name: "social_confirm_publish",
    resourceUri, approved: true, arguments: { review_id: review.id, revision: review.digest, decision: "reject", project: review.project },
  }]);
  expect(releaseMcpApp.mock.calls[0]).toEqual(["company", "lease"]);
});
