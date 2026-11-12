import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { configureAiopcQmd } from "./aiopc-qmd.mjs";

test("knowledge worker launches with packaged Electron and matching SQLite extension", () => {
  const root = path.resolve("fixtures", "resources");
  const folder = path.join(root, "aiopc-qmd");
  const node = path.resolve("fixtures", "AIOPC");
  const runner = path.join(folder, "aiopc-qmd.mjs");
  const extension = path.join(folder, "darwin-arm64", "vec0.dylib");
  const env = {};
  assert.equal(configureAiopcQmd({
    app: { isPackaged: true }, resourcesPath: root, desktopRoot: "", platform: "darwin",
    arch: "arm64", env, node, exists: value => [runner, extension].includes(value),
  }), true);
  assert.deepEqual(env, {
    AIOPC_QMD_NODE: node, AIOPC_QMD_RUNNER: runner, AIOPC_QMD_VECTOR_EXTENSION: extension,
  });
});

test("dev knowledge worker uses generated resources and respects explicit runner configuration", () => {
  const desktopRoot = path.resolve("fixtures", "desktop");
  const folder = path.join(desktopRoot, "dist", "aiopc-qmd");
  const runner = path.join(folder, "aiopc-qmd.mjs");
  const env = {};
  assert.equal(configureAiopcQmd({
    app: { isPackaged: false }, desktopRoot, env, platform: "linux", arch: "x64",
    exists: value => value === runner,
  }), true);
  assert.equal(env.AIOPC_QMD_RUNNER, runner);
  assert.equal(env.AIOPC_QMD_VECTOR_EXTENSION, undefined);
  assert.equal(configureAiopcQmd({
    app: { isPackaged: false }, desktopRoot, env, exists: () => false,
  }), true);
});
