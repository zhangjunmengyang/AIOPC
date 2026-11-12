import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCompanyProject, listCompanyProjects, resolveCompanyExecutionDirectory } from "../src/company-projects.js";
import { ensureWorkspaceFiles } from "../src/workspace-init.js";

test("company bootstrap establishes discovery boundary before any project or engine exists", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-company-bootstrap-")));
  try {
    const company = join(root, "company");
    await ensureWorkspaceFiles(company, "starter");
    assert.ok((await lstat(join(company, ".git"))).isDirectory());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("company execution directories accept real direct projects and reject escapes or nested folders", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "aiopc-company-"));
  const root = await realpath(temporary);
  const company = join(root, "company");
  const project = join(company, "projects", "设计");
  const outside = join(root, "outside");
  await mkdir(join(project, "nested"), { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(company, "projects", "linked"));
  try {
    assert.equal(await resolveCompanyExecutionDirectory(company, project), project);
    for (const directory of [undefined, company, outside, join(project, "nested"), join(company, "projects"),
      join(company, "projects", "linked"), join(company, "projects", "missing"), { directory: project }]) {
      assert.equal(await resolveCompanyExecutionDirectory(company, directory), company);
    }
    assert.deepEqual(await listCompanyProjects(company), [{ id: "proj:设计", name: "设计", directory: project }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project creation preserves an existing directory and does not follow a projects symlink", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiopc-project-create-")));
  const company = join(root, "company");
  await mkdir(company);
  try {
    const created = await createCompanyProject(company, "产品 A");
    assert.ok((await lstat(join(company, ".git"))).isDirectory(), "company is the native engine discovery boundary");
    assert.deepEqual(created, { id: "proj:产品 A", name: "产品 A", directory: join(company, "projects", "产品 A") });
    assert.deepEqual(await createCompanyProject(company, "产品 A"), created);
    for (const name of ["../outside", ".hidden", "a/b", "a\\b", "", "..", "a\u0000b"]) {
      await assert.rejects(() => createCompanyProject(company, name));
    }
    const other = join(root, "other");
    await mkdir(other);
    await symlink(other, join(other, "projects"));
    await assert.rejects(() => createCompanyProject(other, "escaped"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
