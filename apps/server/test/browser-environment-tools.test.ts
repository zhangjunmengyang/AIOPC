import assert from "node:assert/strict";
import { test } from "node:test";
import { server } from "../src/opencode-plugins/openwork-chrome-devtools.js";

test("every browser tool accepts explicit environment selection", async () => {
  const plugin = await server();
  for (const [name, tool] of Object.entries(plugin.tool)) {
    const schema = (tool.args as Record<string, any>).environment;
    assert.ok(schema, `${name} must accept an environment when a project binds more than one`);
    assert.equal(schema.parse("env_123"), "env_123");
    assert.equal(schema.parse(undefined), undefined);
  }
  assert.ok(!plugin.tool.browser_handoff.description.includes("resumes by itself"));
});
