import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listCompanyProjectSkillNames } from "../src/company-role-admission.js";
import { applyCompanyRoleSkillsV1 } from "../src/opencode-plugins/company-role-skills-v1.js";
import {
  ensureCompanyRolePacks,
  listCompanyRoles,
  readCompanyRole,
  readAdoptedProjectSkillNames,
  roleAllowsSkill,
} from "../src/company-roles.js";

async function temporaryCompany(run: (company: string) => Promise<void>) {
  const company = await realpath(await mkdtemp(join(tmpdir(), "aiopc-roles-")));
  try { await run(company); } finally { await rm(company, { recursive: true, force: true }); }
}

async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const locked = (name: string) => ({ id: `skill-${name}`, hash: "a".repeat(64), has_scripts: false });

function skillPath(root: string, name: string) {
  return join(root, ".opencode", "skills", name, "SKILL.md");
}

async function skill(root: string, name: string) {
  await put(skillPath(root, name), `---\nname: ${name}\ndescription: Fixture\n---\nFixture.\n`);
}

const role = (label: string, reportsTo: string | null = null) => `---\ndescription: 我的角色\nmode: primary\nmetadata:\n  aiopc:\n    name: ${label}\n    reportsTo: ${reportsTo}\n    skills: [resident]\n---\n角色说明。\n`;

test("factory packs seed native role and working skills without overwriting company edits", () => temporaryCompany(async company => {
  const path = join(company, ".opencode", "agent", "brand-designer.md");
  await Promise.all([ensureCompanyRolePacks(company), ensureCompanyRolePacks(company)]);
  const designer = await readCompanyRole(company, "brand-designer");
  expect(designer).toMatchObject({ name: "品牌设计师", source: "factory", reportsTo: null, mode: "primary" });
  expect(designer?.skills.length).toBeGreaterThanOrEqual(5);
  for (const name of designer!.skills) expect(await readFile(skillPath(company, name), "utf8")).toContain(`name: ${name}`);
  const edited = (await readFile(path, "utf8")) + "\n公司自己的修改。\n";
  await writeFile(path, edited);
  await ensureCompanyRolePacks(company);
  expect(await readFile(path, "utf8")).toBe(edited);
}));

test("company role metadata supplies reporting lines and ignores sibling roles and linked files", () => temporaryCompany(async company => {
  await put(join(company, ".opencode", "agents", "lead.md"), role("负责人"));
  await put(join(company, ".opencode", "agent", "writer.md"), role("写作者", "lead"));
  await put(join(company, "projects", "A", ".opencode", "agent", "outsider.md"), role("项目角色"));
  await symlink(join(company, ".opencode", "agents", "lead.md"), join(company, ".opencode", "agent", "link.md"));
  expect(await listCompanyRoles(company)).toEqual([
    { id: "lead", name: "负责人", description: "我的角色", reportsTo: null, skills: ["resident"], source: "local", mode: "primary" },
    { id: "writer", name: "写作者", description: "我的角色", reportsTo: "lead", skills: ["resident"], source: "local", mode: "primary" },
  ]);
  expect(await readCompanyRole(company, "../lead")).toBeNull();
}));

test("role allowlist takes only its resident package and complete adoptions in its own project", () => temporaryCompany(async company => {
  const project = join(company, "projects", "A");
  const sibling = join(company, "projects", "B");
  await put(join(company, ".opencode", "agent", "writer.md"), role("写作者"));
  await skill(company, "resident");
  await skill(company, "other-role");
  await skill(project, "adopted");
  await skill(project, "unlocked");
  await skill(sibling, "linked");
  await skill(sibling, "adopted");
  await symlink(dirname(skillPath(sibling, "linked")), dirname(skillPath(project, "linked")));
  await put(join(project, ".opencode", "skills-lock.json"), JSON.stringify({ version: 1, skills: {
    adopted: locked("adopted"), missing: locked("missing"), linked: locked("linked"), unlocked: { id: "broken-hash" },
  } }));
  const writer = await readCompanyRole(company, "writer");
  const adopted = await readAdoptedProjectSkillNames(project);
  expect(adopted).toEqual(["adopted"]);
  const policy = { role: writer!, company, project, adopted };
  expect(roleAllowsSkill(policy, { id: "resident", path: skillPath(company, "resident") })).toBe(true);
  expect(roleAllowsSkill(policy, { id: "adopted", path: skillPath(project, "adopted") })).toBe(true);
  expect(roleAllowsSkill(policy, { id: "adopted", path: skillPath(sibling, "adopted") })).toBe(false);
  expect(roleAllowsSkill(policy, { id: "resident", path: skillPath(project, "resident") })).toBe(false);
  expect(roleAllowsSkill(policy, { id: "other-role", path: skillPath(company, "other-role") })).toBe(false);
  expect(roleAllowsSkill(policy, { id: "linked", path: skillPath(project, "linked") })).toBe(false);
  expect(roleAllowsSkill({ ...policy, project: null }, { id: "adopted", path: skillPath(project, "adopted") })).toBe(false);
}));


test("v1 role permission materializes named rules without removing an existing global skill restriction", () => temporaryCompany(async company => {
  await ensureCompanyRolePacks(company);
  const project = join(company, "projects", "A");
  await skill(project, "adopted");
  await put(join(project, ".opencode", "skills-lock.json"), JSON.stringify({ version: 1, skills: { adopted: locked("adopted") } }));
  const agent = { permission: { edit: "ask" as const } };
  await applyCompanyRoleSkillsV1({ permission: { skill: { "brand-logo": "deny" } }, agent: { "brand-designer": agent } }, project, company);
  expect(agent.permission).toMatchObject({ edit: "ask", skill: {
    "*": "deny", "brand-naming": "allow", "brand-logo": "deny", adopted: "allow",
  } });
}));


test("company role catalog excludes another registered company under projects", () => temporaryCompany(async company => {
  const project = join(company, "projects", "own");
  const nestedCompany = join(company, "projects", "registered-company");
  await mkdir(project, { recursive: true });
  await skill(nestedCompany, "separate-company-skill");
  await put(join(nestedCompany, ".opencode", "skills-lock.json"), JSON.stringify({ version: 1, skills: {
    "separate-company-skill": locked("separate-company-skill"),
  } }));
  const registeredAlias = join(company, "registered-alias");
  await symlink(nestedCompany, registeredAlias);
  expect(await listCompanyProjectSkillNames(company, [company, registeredAlias])).toEqual({ "proj:own": [] });
}));
