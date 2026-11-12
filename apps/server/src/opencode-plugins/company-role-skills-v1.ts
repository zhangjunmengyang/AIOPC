import { realpath } from "node:fs/promises";
import { companyDirectoryForExecution } from "../company-projects.js";
import { companyRoleSkillCandidates, listCompanyRoles, readAdoptedProjectSkillNames } from "../company-roles.js";
import { skillPermissionMatches } from "./company-role-permission-pattern.js";

type Effect = "allow" | "ask" | "deny";
type Rules = Effect | Record<string, Effect | Record<string, Effect>>;
type Config = { permission?: Rules; agent?: Record<string, { permission?: Rules }> };

function ruleEntries(rules: Rules | undefined) {
  return typeof rules === "string" ? [["*", rules] as const] : Object.entries(rules ?? {});
}

function skillEffect(rules: Rules | undefined, id: string): Effect | undefined {
  for (const [action, value] of ruleEntries(rules).reverse()) {
    if (!skillPermissionMatches("skill", action)) continue;
    if (typeof value === "string") return value;
    for (const [pattern, effect] of Object.entries(value).reverse()) {
      if (skillPermissionMatches(id, pattern)) return effect;
    }
  }
  return undefined;
}

/** V1's config hook runs in the native execution directory before agent selection. */
export async function applyCompanyRoleSkillsV1(config: Config, directory: string): Promise<void> {
  const execution = await realpath(directory);
  const company = companyDirectoryForExecution(execution);
  const project = execution === company ? null : execution;
  const [roles, adopted] = await Promise.all([listCompanyRoles(company), project ? readAdoptedProjectSkillNames(project) : []]);
  for (const role of roles) {
    const agent = config.agent?.[role.id];
    if (!agent) continue;
    const candidates = companyRoleSkillCandidates({ role, company, project, adopted });
    const skill: Record<string, Effect> = { "*": "deny" };
    for (const { id } of candidates) skill[id] = skillEffect(agent.permission, id) ?? skillEffect(config.permission, id) ?? "allow";
    agent.permission = { ...Object.fromEntries(ruleEntries(agent.permission).filter(([action]) => action !== "skill")), skill };
  }
}
