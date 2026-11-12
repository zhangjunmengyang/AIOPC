import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalProviderReload } from "../src/local-provider-reload.js";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(2);
  assert.ok(predicate(), "the scheduled reload should finish");
}

test("local credential reload retries while work is active and coalesces repeated requests", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const reload = createLocalProviderReload({ retryMs: 1, reload: async () => {
    calls++;
    if (calls === 1) return false;
    if (calls === 2) await new Promise<void>(resolve => { release = resolve; });
    return true;
  } });
  try {
    reload.request(); reload.request();
    await until(() => release !== undefined);
    reload.request(); reload.request();
    await delay(10);
    assert.equal(calls, 2, "an active reload must not overlap another");
    release!();
    await until(() => calls === 3);
    await delay(10);
    assert.equal(calls, 3, "requests during one reload produce one later reload");
  } finally { reload.stop(); }
});

test("stopping cancels a pending retry", async () => {
  let calls = 0;
  const reload = createLocalProviderReload({ retryMs: 1, reload: async () => { calls++; return false; } });
  reload.request();
  await until(() => calls > 0);
  reload.stop();
  const stoppedAt = calls;
  await delay(10);
  reload.request();
  await delay(10);
  assert.equal(calls, stoppedAt);
});
