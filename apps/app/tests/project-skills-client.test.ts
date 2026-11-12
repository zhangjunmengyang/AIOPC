import { afterEach, expect, test } from "bun:test";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";

const savedFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = savedFetch; });
test("skill list and content retain company ownership while requesting the project directory", async () => {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(new URL(new Request(input, init).url));
    return Response.json({ items: [], name: "role", content: "" });
  }) as typeof fetch;
  const client = createOpenworkServerClient({ baseUrl: "http://localhost:9", token: "test" });
  await client.listSkills("company", { includeGlobal: true, directory: "/company/projects/Alpha" });
  await client.getSkill("company", "role", { directory: "/company/projects/Alpha" });
  expect(urls.map(url => url.pathname)).toEqual(["/workspace/company/skills", "/workspace/company/skills/role"]);
  expect(urls.map(url => url.searchParams.get("directory"))).toEqual(["/company/projects/Alpha", "/company/projects/Alpha"]);
  expect(urls[0]?.searchParams.get("includeGlobal")).toBe("true");
});

test("role clearing uses the server metadata endpoint and preserves its returned snapshot", async () => {
  const state = { groups: [{ id: "proj:A", label: "A" }], assignments: { session: "proj:A" }, sessionMeta: { session: {} } };
  let captured: { url: URL; method: string; body: unknown } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    captured = { url: new URL(request.url), method: request.method, body: await request.json() };
    return Response.json({ state, updatedAt: 123 });
  }) as typeof fetch;
  const client = createOpenworkServerClient({ baseUrl: "http://localhost:9", token: "test" });
  const response = await client.setSessionAgent("company", "session", null);
  expect(captured?.url.pathname).toBe("/workspace/company/session-groups/meta/session");
  expect(captured?.method).toBe("PATCH");
  expect(captured?.body).toEqual({ agentName: null });
  expect(response.state).toEqual(state);
});
