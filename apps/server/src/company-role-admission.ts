import { ApiError } from "./errors.js";
import { roleAllowsSkill, type RoleSkillPolicy } from "./company-roles.js";
import { isRecord } from "./workspace-kv-store.js";

export async function assertCompanyRoleSkillInput(
  policy: RoleSkillPolicy,
  operation: string,
  payload: unknown,
  readSkills: () => Promise<unknown>,
): Promise<void> {
  if (!isRecord(payload)) return;
  const ids = operation === "skill" ? [payload.id]
    : operation === "permission" && payload.action === "skill" && Array.isArray(payload.resources) ? payload.resources
    : Array.isArray(payload.skills) ? payload.skills.map(item => isRecord(item) ? item.id : undefined)
    : [];
  const requested = ids.filter((id): id is string => typeof id === "string");
  if (!requested.length) return;
  const catalog = await readSkills();
  const data = isRecord(catalog) && Array.isArray(catalog.data) ? catalog.data : [];
  for (const id of requested) {
    const entry = data.find(item => isRecord(item) && item.id === id);
    const path = isRecord(entry) && typeof entry.path === "string" ? entry.path : undefined;
    if (!roleAllowsSkill(policy, { id, path })) throw new ApiError(403, "role_skill_denied", `当前角色没有使用技能 ${id} 的权限`);
  }
}

export function companyRoleV1Prompt(policy: RoleSkillPolicy, payload: Record<string, unknown>): string {
  // V1's deprecated per-turn tool toggles are persisted on the session and can
  // replace the agent's native permission. Preserve unrelated tool choices.
  const tools = isRecord(payload.tools) ? Object.fromEntries(Object.entries(payload.tools).filter(([name]) => name !== "skill" && name !== "*")) : undefined;
  return JSON.stringify({ ...payload, agent: policy.role.id, ...(tools ? { tools } : {}) });
}
