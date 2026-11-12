import { afterEach, expect, test } from "bun:test";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("V2 company pending approvals use the scoped aggregate, including project sessions", async () => {
  const requests: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    return Response.json({ data: [
      { id: "per_1", sessionID: "ses_alpha", action: "edit", resources: ["brand.md"] },
      { id: "per_2", sessionID: "ses_beta", action: "bash", resources: ["true"] },
    ] });
  }) as typeof fetch;

  const client = createClientV2("http://127.0.0.1:9/workspace/test-company/opencode2", "/test-company", { token: "test" });
  const result = await client.listWorkspacePermissions();
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/workspace/test-company/opencode2/api/permission/request",
  ]);
  expect(result.data?.map(({ sessionID, permission }) => [sessionID, permission])).toEqual([
    ["ses_alpha", "edit"], ["ses_beta", "bash"],
  ]);
});
