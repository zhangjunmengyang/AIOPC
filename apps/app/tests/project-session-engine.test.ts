import { afterEach, expect, test } from "bun:test";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";

const savedFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = savedFetch; });

test("v2 session creation keeps company home separate from the project execution directory", async () => {
  const requests: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/api/info")) return Response.json({ version: "2.2.0", pid: 1 });
    if (request.method === "POST") requests.push(await request.json());
    return Response.json({ data: { id: "session-project", title: "Product task", openworkHomeDirectory: "/company",
      projectId: "proj:Alpha", executionDirectory: "/company/projects/Alpha", location: { directory: "/company/projects/Alpha" }, time: { created: 1, updated: 1 } } });
  }) as typeof fetch;
  const client = createClientV2("http://127.0.0.1:9/workspace/company/opencode2", "/company", { token: "test" });
  const created = await client.session.create({ directory: "/company/projects/Alpha" });
  expect(requests).toEqual([{ location: { directory: "/company/projects/Alpha" } }]);
  expect(created.data?.directory).toBe("/company");
  expect(Reflect.get(created.data!, "executionDirectory")).toBe("/company/projects/Alpha");
  expect(Reflect.get(created.data!, "projectId")).toBe("proj:Alpha");
  const restored = await client.session.get({ sessionID: "session-project" });
  expect(restored.data?.directory).toBe("/company");
  expect(Reflect.get(restored.data!, "executionDirectory")).toBe("/company/projects/Alpha");
});

test("v2 role discovery sends the project execution directory", async () => {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    urls.push(url);
    return Response.json({ data: [] });
  }) as typeof fetch;
  const client = createClientV2("http://localhost:9/opencode2", "/company/projects/Alpha", { token: "test" });
  await client.app.agents();
  expect(urls.at(-1)?.searchParams.get("directory")).toBe("/company/projects/Alpha");
});
