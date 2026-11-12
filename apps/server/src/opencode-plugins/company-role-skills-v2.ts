import { skillPermissionMatches } from "./company-role-permission-pattern.js";
import { companyRoleSkillCandidates, listCompanyRoles, readAdoptedProjectSkillNames, roleAllowsSkill, type RoleSkillPolicy } from "../company-roles.js";

type Registration = { dispose(): Promise<void> };
type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" };
type NativeSkill = { id: string; path?: string };
type NativeAgent = { id: string; permissions: Rule[] };
export type RolePrompt = { sessionID: string; prompt: { skills?: readonly { id: string }[] } };
export type CompanyRoleSkillContext = {
  agent?: { transform(callback: (editor: {
    list(): readonly NativeAgent[];
    update(id: string, update: (agent: NativeAgent) => void): void;
  }) => void): Promise<Registration> };
  session: { get?(input: { sessionID: string }): Promise<{ agent?: string }> };
  skill: { list?(): Promise<{ data: readonly NativeSkill[] }> };
  permission?: { hook(name: "evaluate", callback: (event: {
    sessionID: string; agent?: string; action: string; resources: readonly string[];
    effect: Rule["effect"]; message?: string;
  }) => Promise<void>): Promise<Registration> };
};

function previousSkillEffect(rules: Rule[], id: string): Rule["effect"] {
  for (const rule of [...rules].reverse()) {
    if (skillPermissionMatches("skill", rule.action) && skillPermissionMatches(id, rule.resource)) return rule.effect;
  }
  return "allow";
}

export async function createCompanyRoleSkillRules(context: CompanyRoleSkillContext, company: string, project: string | null) {
  let registration: Registration | undefined;
  let current = new Map<string, ReadonlySet<string>>();
  const resolveAgent = async (sessionID: string, agent?: string) => agent ?? (await context.session.get?.({ sessionID }))?.agent;
  const permission = await context.permission?.hook("evaluate", async (event) => {
    if (event.action !== "skill") return;
    const id = await resolveAgent(event.sessionID, event.agent);
    const allowed = id ? current.get(id) : undefined;
    if (allowed && event.resources.some(resource => !allowed.has(resource))) {
      event.effect = "deny";
      event.message = "当前角色没有使用此技能的权限";
    }
  });
  return {
    async refresh(useNativeCatalog = true) {
      if (!context.agent) return;
      const [roles, adopted, skills] = await Promise.all([
        listCompanyRoles(company),
        project ? readAdoptedProjectSkillNames(project) : [],
        useNativeCatalog ? context.skill.list?.() : undefined,
      ]);
      current = new Map(roles.map(role => {
        const policy: RoleSkillPolicy = { role, company, project, adopted };
        const candidates = skills ? skills.data.filter(skill => roleAllowsSkill(policy, skill)) : companyRoleSkillCandidates(policy);
        return [role.id, new Set(candidates.map(skill => skill.id))];
      }));
      const previous = registration;
      const scoped = current;
      registration = await context.agent.transform(editor => {
        for (const { id } of editor.list()) {
          const allowed = scoped.get(id);
          if (!allowed) continue;
          editor.update(id, agent => {
            const rules = [...allowed].map(resource => ({ action: "skill", resource, effect: previousSkillEffect(agent.permissions, resource) }));
            agent.permissions.push({ action: "skill", resource: "*", effect: "deny" }, ...rules);
          });
        }
      });
      await previous?.dispose();
    },
    async assertAttachments(event: RolePrompt) {
      const skills = event.prompt.skills;
      if (!skills?.length) return;
      const id = await resolveAgent(event.sessionID);
      const allowed = id ? current.get(id) : undefined;
      const denied = allowed && skills.find(skill => !allowed.has(skill.id));
      if (denied) throw new Error(`当前角色没有使用技能 ${denied.id} 的权限`);
    },
    async dispose() { await permission?.dispose(); await registration?.dispose(); },
  };
}
