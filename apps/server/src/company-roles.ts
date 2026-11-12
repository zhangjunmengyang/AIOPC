import { realpathSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { companyRolePacks } from "./company-role-packs.js";
import { buildFrontmatter, parseFrontmatter } from "./frontmatter.js";

export type CompanyRole = {
  id: string;
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  source: "factory" | "local";
  reportsTo: string | null;
  skills: string[];
};

export type RoleSkillPolicy = {
  role: CompanyRole;
  company: string;
  project: string | null;
  adopted: readonly string[];
};

const roleDirectories = ["agents", "agent"];
const skillId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const roleId = /^[^./\\\u0000-\u0020\u007f][^/\\\u0000-\u001f\u007f]{0,127}$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function skillName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && skillId.test(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function regularFile(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null))?.isFile() === true && await realpath(path).catch(() => null) === path;
}

function skillFile(root: string, id: string): string {
  return join(root, ".opencode", "skills", id, "SKILL.md");
}

export async function readCompanyRole(company: string, id: string): Promise<CompanyRole | null> {
  if (!roleId.test(id)) return null;
  const root = await realpath(company);
  for (const directory of roleDirectories) {
    const path = join(root, ".opencode", directory, `${id}.md`);
    if (!(await regularFile(path))) continue;
    const { data } = parseFrontmatter(await readFile(path, "utf8"));
    if (data.disable === true || data.disabled === true || data.hidden === true) return null;
    const fields = record(record(data.metadata)?.aiopc);
    const manager = string(fields?.reportsTo);
    return {
      id,
      name: string(fields?.name) ?? id,
      description: string(data.description) ?? "",
      mode: data.mode === "primary" || data.mode === "subagent" ? data.mode : "all",
      source: fields?.source === "factory" && companyRolePacks.some(pack => pack.id === id) ? "factory" : "local",
      reportsTo: manager && roleId.test(manager) && manager !== id ? manager : null,
      skills: Array.isArray(fields?.skills) ? [...new Set(fields.skills.filter(skillName))] : [],
    };
  }
  return null;
}

export async function listCompanyRoles(company: string): Promise<CompanyRole[]> {
  const entries = await Promise.all(roleDirectories.map(directory => readdir(join(company, ".opencode", directory), { withFileTypes: true }).catch(() => [])));
  const ids = new Set(entries.flat().filter(entry => entry.isFile() && entry.name.endsWith(".md")).map(entry => entry.name.slice(0, -3)));
  const roles = await Promise.all([...ids].sort().map(id => readCompanyRole(company, id).catch(() => null)));
  return roles.filter(role => role !== null);
}

/** Only skillhub adoptions whose package is installed in this project. */
export async function readAdoptedProjectSkillNames(project: string): Promise<string[]> {
  const root = await realpath(project);
  const lockPath = join(root, ".opencode", "skills-lock.json");
  if (!(await regularFile(lockPath))) return [];
  let lock: Record<string, unknown> | undefined;
  try { lock = record(JSON.parse(await readFile(lockPath, "utf8")) as unknown); } catch { return []; }
  const skills = record(lock?.skills);
  if (lock?.version !== 1 || !skills) return [];
  const entries = await Promise.all(Object.entries(skills).map(async ([id, raw]) => {
    const entry = record(raw);
    return skillName(id) && string(entry?.id) && typeof entry?.hash === "string" && /^[0-9a-f]{64}$/.test(entry.hash)
      && await regularFile(skillFile(root, id)) ? id : null;
  }));
  return entries.filter(id => id !== null).sort();
}

export function companyRoleSkillCandidates(policy: RoleSkillPolicy): Array<{ id: string; path: string }> {
  return [
    ...policy.role.skills.map(id => ({ id, path: skillFile(policy.company, id) })),
    ...(policy.project ? policy.adopted.map(id => ({ id, path: skillFile(policy.project!, id) })) : []),
  ].filter(skill => roleAllowsSkill(policy, skill));
}

/** Shared by native skill admission and host tools that resolve a concrete package. */
export function roleAllowsSkill(policy: RoleSkillPolicy, skill: { id: string; path?: string }): boolean {
  if (!skillName(skill.id) || !skill.path || !isAbsolute(skill.path)) return false;
  try { if (realpathSync(skill.path) !== skill.path) return false; } catch { return false; }
  if (policy.project && policy.adopted.includes(skill.id) && skill.path === skillFile(policy.project, skill.id)) return true;
  return policy.role.skills.includes(skill.id) && skill.path === skillFile(policy.company, skill.id);
}

export async function readRoleSkillPolicy(company: string, project: string | null, agentName: string): Promise<RoleSkillPolicy | null> {
  const root = await realpath(company);
  const role = await readCompanyRole(root, agentName);
  if (!role) return null;
  return { role, company: root, project, adopted: project ? await readAdoptedProjectSkillNames(project) : [] };
}

async function plainDirectory(path: string): Promise<boolean> {
  await mkdir(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  return (await lstat(path)).isDirectory();
}

async function writeMissing(path: string, value: string): Promise<void> {
  await writeFile(path, value, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

/** Keep existing role/skill files and directory links untouched. */
export async function ensureCompanyRolePacks(company: string): Promise<void> {
  const root = await realpath(company);
  const config = join(root, ".opencode");
  if (!await plainDirectory(config)) return;
  const agents = join(config, "agent");
  const skills = join(config, "skills");
  if (!await plainDirectory(agents) || !await plainDirectory(skills)) return;
  for (const pack of companyRolePacks) {
    // Preserve the alternative native spelling of an existing role file.
    if (await lstat(join(config, "agents", `${pack.id}.md`)).catch(() => null)) continue;
    for (const skill of pack.skills) {
      const folder = join(skills, skill.id);
      if (!await plainDirectory(folder)) continue;
      await writeMissing(join(folder, "SKILL.md"), `${buildFrontmatter({ name: skill.id, description: skill.description })}${skill.body}\n`);
    }
    await writeMissing(join(agents, `${pack.id}.md`), buildFrontmatter({
      description: pack.description,
      mode: "primary",
      metadata: { aiopc: { name: pack.name, source: "factory", skills: pack.skills.map(skill => skill.id) } },
    }) + `${pack.prompt}\n`);
  }
}
