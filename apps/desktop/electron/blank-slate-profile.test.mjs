import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { prepareBlankSlateProfile } from "./blank-slate-profile.mjs";

test("blank-slate uses isolated XDG history without pinning both engines to one database", () => {
  const env = { OPENCODE_DB: "/existing/user-history.sqlite" };
  const root = path.resolve("isolated-test-profile");
  const profile = prepareBlankSlateProfile({
    argv: ["--blank-slate"], env,
    createTempRoot: () => root,
    createDirectory: () => {},
  });
  assert.equal(env.OPENCODE_DB, undefined);
  assert.equal(profile.environment.OPENCODE_DB, undefined);
  assert.equal(env.XDG_DATA_HOME, path.join(root, "xdg", "data"));
});

test("regular launches keep a user-provided history database", () => {
  const env = { OPENCODE_DB: "/existing/user-history.sqlite" };
  assert.equal(prepareBlankSlateProfile({ argv: [], env }), null);
  assert.equal(env.OPENCODE_DB, "/existing/user-history.sqlite");
});
