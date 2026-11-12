import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiError } from "../src/errors.js";
import { isProjectTaskId, requireProjectTaskFile } from "../src/project-task-files.js";

test("task lookup accepts safe Markdown IDs in the selected project only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aiopc-task-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "alpha");
  const tasks = join(project, "tasks");
  await mkdir(tasks, { recursive: true });
  await writeFile(join(tasks, "launch-draft.md"), "---\ntitle: Launch\n---\n");

  assert.equal(isProjectTaskId("launch-draft"), true);
  for (const id of ["../beta", "alpha/beta", ".hidden", "with space", "", "a".repeat(129)]) {
    assert.equal(isProjectTaskId(id), false);
    await assert.rejects(requireProjectTaskFile(project, id), (error: unknown) => error instanceof ApiError && error.status === 400);
  }
  await requireProjectTaskFile(project, "launch-draft");
  await assert.rejects(requireProjectTaskFile(project, "missing"), (error: unknown) => error instanceof ApiError && error.status === 404);
  await mkdir(join(tasks, "folder.md"));
  await symlink(join(tasks, "launch-draft.md"), join(tasks, "symlink.md"));
  await mkdir(join(root, "beta"));
  await symlink(tasks, join(root, "beta", "tasks"));
  await assert.rejects(requireProjectTaskFile(project, "folder"));
  await assert.rejects(requireProjectTaskFile(project, "symlink"));
  await assert.rejects(requireProjectTaskFile(join(root, "beta"), "launch-draft"));
});
