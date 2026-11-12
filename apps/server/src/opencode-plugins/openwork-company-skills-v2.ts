import { createCompanyRoleSkillRules, type CompanyRoleSkillContext, type RolePrompt } from "./company-role-skills-v2.js";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Context = CompanyRoleSkillContext & {
  location?: { directory?: string };
  options?: { trustedDirectories?: string[] };
  session: { hook(name: "prompt", callback: (event: RolePrompt) => Promise<void>): Promise<{ dispose(): Promise<void> }> };
  skill: { transform(callback: (editor: {
    list(): readonly { id: string; path?: string }[];
    remove(id: string): void;
  }) => void): Promise<{ dispose(): Promise<void> }> };
};

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/** V2 scans ancestors past Git roots. Restrict its executable skill registry. */
export default {
  id: "aiopc.company-skills",
  async setup(context: Context) {
    const execution = context.location?.directory ? canonical(context.location.directory) : null;
    const company = execution && basename(dirname(execution)) === "projects" ? dirname(dirname(execution)) : execution;
    // Explicit bundle/config paths and the user's standard global skill roots
    // remain usable; arbitrary ancestor .opencode directories do not.
    const trusted = [...(context.options?.trustedDirectories ?? []),
      join(homedir(), ".opencode", "skills"), join(homedir(), ".opencode", "skill"),
      join(homedir(), ".config", "opencode", "skills"), join(homedir(), ".config", "opencode", "skill"),
      join(homedir(), ".claude", "skills"), join(homedir(), ".agents", "skills"), join(homedir(), ".agent", "skills"),
    ].map(canonical);
    const transform = () => context.skill.transform(editor => {
      if (!company || !execution) return;
      for (const skill of editor.list()) {
        if (!skill.path || !isAbsolute(skill.path)) continue; // Native skill:// resources are built in.
        const path = canonical(skill.path);
        const shared = inside(company, path) && !inside(join(company, "projects"), path);
        const current = execution !== company && inside(execution, path);
        if (!shared && !current && !trusted.some(root => inside(root, path))) editor.remove(skill.id);
      }
    });
    let registration = await transform();
    const roles = company && execution ? await createCompanyRoleSkillRules(context, company, company === execution ? null : execution) : null;
    await roles?.refresh(false);
    let refresh: Promise<void> = Promise.resolve();
    // Native filesystem sources finish registering after external setup. Prompt
    // hooks run after location plugins are ready and before selected-skill
    // resolution, so append the policy there. Each later filesystem reload
    // replays this final transform as well. Never accumulate per-turn filters.
    const hook = await context.session.hook("prompt", async event => {
      refresh = refresh.catch(() => {}).then(async () => {
        const previous = registration;
        registration = await transform();
        await previous.dispose();
        await roles?.refresh();
      });
      await refresh;
      await roles?.assertAttachments(event);
    });
    return async () => { await hook.dispose(); await refresh; await roles?.dispose(); await registration.dispose(); };
  },
};
