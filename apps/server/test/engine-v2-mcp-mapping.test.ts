import assert from "node:assert/strict";
import { test } from "node:test";
import { mapRuntimeMcpToV2 } from "../src/engine-v2-preview.js";

const remote = {
  type: "remote",
  url: "https://connect.example.test/mcp/agent",
  headers: { Authorization: "Bearer synthetic-test-token" },
  oauth: false,
};

test("remote MCP mapping omits unsupported configuration", () => {
  assert.deepEqual(mapRuntimeMcpToV2({
    ...remote,
    protocol: "unsupported-runtime-value",
    clientInfo: { name: "not-a-config-field" },
    codemode: false,
    timeout: 12_000,
  }, "account-mcp"), {
    ...remote,
    codemode: false,
    timeout: { startup: 12_000, catalog: 12_000, execution: 12_000 },
  });
});

test("generic remote MCPs keep the legacy default even with the same URL or runtime protocol fields", () => {
  for (const name of [undefined, "third-party", "account-mcp-copy"]) {
    assert.deepEqual(mapRuntimeMcpToV2({ ...remote, protocol: "auto", clientInfo: { name: "ignored" } }, name), remote);
  }
});

test("local and disabled MCPs do not acquire a modern protocol", () => {
  assert.deepEqual(mapRuntimeMcpToV2({ type: "local", command: ["example-mcp"], protocol: "auto" }, "account-mcp"), {
    type: "local", command: ["example-mcp"], environment: {},
  });
  assert.equal(mapRuntimeMcpToV2({ ...remote, enabled: false }, "account-mcp"), undefined);
  assert.equal(mapRuntimeMcpToV2({ ...remote, disabled: true }, "account-mcp"), undefined);
  assert.equal(mapRuntimeMcpToV2({ ...remote, url: "file:///invalid" }, "account-mcp"), undefined);
});

test("reconciliation fingerprints supported configuration and credentials", () => {
  // The reconciler fingerprints the mapped config, not the persisted V1 input.
  const fingerprint = (value: unknown, name?: string) => JSON.stringify(mapRuntimeMcpToV2(value, name));
  const previous = fingerprint(remote);
  const managed = fingerprint(remote, "account-mcp");
  assert.equal(managed, previous, "the server name does not change the protocol");
  assert.equal(fingerprint(remote, "third-party"), previous, "generic registrations are not restarted");
  assert.equal(fingerprint({ ...remote, protocol: "legacy", unsupported: true }, "account-mcp"), managed,
    "ignored source fields cannot cause perpetual managed re-registration");
  assert.notEqual(fingerprint({ ...remote, headers: { Authorization: "Bearer rotated-test-token" } }, "account-mcp"), managed,
    "credential changes still replace the managed registration");
});
