import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createV2BrowserBridge } from "../src/opencode-v2-browser-bridge.js";

test("browser tools reach the desktop through the v2 browser bridge for the calling conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-website-tools-"));
  const previous = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  const received: Array<{ path: string; body: unknown }> = [];
  const desktop = createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      received.push({ path: request.url ?? "", body: JSON.parse(raw) });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, trust: "untrusted-site-content" }));
    });
  });
  await new Promise<void>(resolve => desktop.listen(0, "127.0.0.1", resolve));
  const address = desktop.address();
  assert.ok(address && typeof address === "object");
  const discovery = join(directory, "openwork-ui-control.json");
  await writeFile(discovery, JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}`, token: "desktop" }));
  process.env.OPENWORK_UI_CONTROL_DISCOVERY = discovery;
  const bridge = await createV2BrowserBridge();
  const call = async (name: string, input: unknown) => {
    const response = await fetch(bridge.url, {
      method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, input, sessionId: "chat" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { content: Array<{ text: string }> };
    return JSON.parse(body.content[0]!.text) as unknown;
  };
  try {
    assert.deepEqual(await call("browser_tabs", {}), { ok: true, trust: "untrusted-site-content" });
    // A conversation named in the arguments is ignored: the call belongs to the conversation that made it.
    await call("browser_open", { url: "https://example.com/", sessionId: "another-chat" });
    assert.deepEqual(received, [
      { path: "/browser/task", body: { operation: "tabs", args: {}, sessionId: "chat" } },
      { path: "/browser/task", body: { operation: "open", args: { url: "https://example.com/" }, sessionId: "chat" } },
    ]);
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_UI_CONTROL_DISCOVERY;
    else process.env.OPENWORK_UI_CONTROL_DISCOVERY = previous;
    await bridge.close();
    await new Promise<void>(resolve => desktop.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
