import assert from "node:assert/strict";
import test from "node:test";

import { isExternalWebUrl, isMainWindowAllowedNavigation } from "./main-window-navigation.mjs";

test("the app window keeps its own files, local services and current origin", () => {
  assert.equal(isMainWindowAllowedNavigation("file:///Applications/AIOPC.app/index.html#/accounts", "file:///Applications/AIOPC.app/index.html"), true);
  assert.equal(isMainWindowAllowedNavigation("http://127.0.0.1:5173/#/session", "http://127.0.0.1:5173/"), true);
  assert.equal(isMainWindowAllowedNavigation("http://localhost:3000/", "file:///index.html"), true);
});

test("a website never replaces the app window", () => {
  assert.equal(isMainWindowAllowedNavigation("https://www.xiaohongshu.com/explore", "file:///Applications/AIOPC.app/index.html"), false);
  assert.equal(isMainWindowAllowedNavigation("https://evil.example/", "http://127.0.0.1:5173/"), false);
  assert.equal(isExternalWebUrl("https://www.xiaohongshu.com/"), true);
  assert.equal(isExternalWebUrl("mailto:someone@example.com"), false);
});
