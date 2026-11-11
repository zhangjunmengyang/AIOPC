import assert from "node:assert/strict"
import { test } from "node:test"
import { isDenDeviceClientId } from "../src/device-clients.ts"

test("the CLI and OpenCode plugin device clients are allowed; other client ids are not", () => {
  assert.equal(isDenDeviceClientId("openwork-cli"), true)
  assert.equal(isDenDeviceClientId("openwork-opencode-plugin"), true)
  assert.equal(isDenDeviceClientId("someone-else"), false)
})
