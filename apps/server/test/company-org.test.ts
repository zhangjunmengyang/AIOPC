import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listCompanyOrgRoles, updateCompanyReportingLine } from "../src/company-org.js";
import { ApiError } from "../src/errors.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "aiopc-org-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agents = join(root, ".opencode", "agent");
  await mkdir(agents, { recursive: true });
  const addRole = (id: string, content: string) => writeFile(join(agents, id + ".md"), content);
  return { root, agents, addRole };
}

const roleDocument = "---\ndescription: 负责设计\nmode: primary\npermission:\n  skill:\n    '*': deny\n---\n\n设计角色的原始指令。\n";

const errorCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;

test("company roles come from the company directory and preserve the existing role definition", async (t) => {
  const { root, agents, addRole } = await fixture(t);
  await Promise.all([addRole("设计", roleDocument), addRole("负责人", "负责人指令\n")]);
  const otherDirectory = join(root, "projects", "Other", ".opencode", "agent");
  await mkdir(otherDirectory, { recursive: true });
  await writeFile(join(otherDirectory, "only-project.md"), roleDocument);
  await symlink(join(otherDirectory, "only-project.md"), join(agents, "alias.md"));
  const roles = await listCompanyOrgRoles(root);
  assert.deepEqual(roles.map((role) => role.id).sort(), ["负责人", "设计"].sort());
  assert.equal(roles.find((role) => role.id === "设计")?.description, "负责设计");
  assert.equal(roles.find((role) => role.id === "设计")?.reportsTo, null);
  await assert.rejects(updateCompanyReportingLine(root, "设计", "only-project"), errorCode("company_role_not_found"));
  await assert.rejects(updateCompanyReportingLine(root, "alias", "负责人"), errorCode("company_role_not_found"));

  await updateCompanyReportingLine(root, "设计", "负责人");
  assert.equal((await listCompanyOrgRoles(root)).find((role) => role.id === "设计")?.reportsTo, "负责人");
  const persisted = await readFile(join(agents, "设计.md"), "utf8");
  assert.ok(persisted.includes("description: 负责设计\nmode: primary\npermission:\n  skill:\n    '*': deny"));
  assert.ok(persisted.endsWith("\n设计角色的原始指令。\n"));

  await updateCompanyReportingLine(root, "设计", null);
  assert.equal((await listCompanyOrgRoles(root)).find((role) => role.id === "设计")?.reportsTo, null);
});

test("rejects direct and indirect cycles without writing an invalid edge", async (t) => {
  const { root, addRole } = await fixture(t);
  await Promise.all(["lead", "design", "product"].map((id) => addRole(id, roleDocument)));
  await updateCompanyReportingLine(root, "product", "design");
  await updateCompanyReportingLine(root, "design", "lead");
  const before = await listCompanyOrgRoles(root);
  await assert.rejects(updateCompanyReportingLine(root, "lead", "lead"), errorCode("company_reporting_cycle"));
  await assert.rejects(updateCompanyReportingLine(root, "lead", "product"), errorCode("company_reporting_cycle"));
  assert.deepEqual(await listCompanyOrgRoles(root), before);
});

test("concurrent reporting edits cannot introduce a cycle", async (t) => {
  const { root, addRole } = await fixture(t);
  await Promise.all(["one", "two"].map((id) => addRole(id, roleDocument)));
  const edits = await Promise.allSettled([
    updateCompanyReportingLine(root, "one", "two"),
    updateCompanyReportingLine(root, "two", "one"),
  ]);
  assert.equal(edits.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(edits.filter((result) => result.status === "rejected" && errorCode("company_reporting_cycle")(result.reason)).length, 1);
  assert.equal((await listCompanyOrgRoles(root)).filter((role) => role.reportsTo !== null).length, 1);
});

test("a symlinked company role directory cannot add another company's roles", async (t) => {
  const { root, agents } = await fixture(t);
  const outside = join(root, "elsewhere");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "outside.md"), roleDocument);
  await rm(agents, { recursive: true });
  await symlink(outside, agents);
  assert.deepEqual(await listCompanyOrgRoles(root), []);
  await assert.rejects(updateCompanyReportingLine(root, "outside", null), errorCode("company_role_not_found"));
});

test("role inventory respects the team catalog's ids, disabled flags, and singular-directory precedence", async (t) => {
  const { root, addRole } = await fixture(t);
  const plural = join(root, ".opencode", "agents");
  await mkdir(plural);
  await Promise.all([
    addRole("disabled", "---\ndisabled: true\n---\n"),
    addRole("hidden", "---\nhidden: true\n---\n"),
    addRole("legacy", "---\ndisable: true\n---\n"),
    addRole(" lead", roleDocument),
    addRole("z".repeat(129), roleDocument),
    addRole("writer", "---\nmetadata:\n  aiopc:\n    name: 正确的角色\n---\n"),
    writeFile(join(plural, "disabled.md"), roleDocument),
    writeFile(join(plural, "writer.md"), roleDocument),
    writeFile(join(plural, "lead.md"), roleDocument),
  ]);
  assert.deepEqual((await listCompanyOrgRoles(root)).map(({ id, name }) => [id, name]), [["lead", "lead"], ["writer", "正确的角色"]]);
  await assert.rejects(updateCompanyReportingLine(root, "writer", "disabled"), errorCode("company_role_not_found"));
});
