import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Context = {
  location?: { directory?: string };
  options?: { trustedDirectories?: string[] };
  session: { hook(name: "prompt", callback: () => Promise<void>): Promise<{ dispose(): Promise<void> }> };
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
    let refresh: Promise<void> = Promise.resolve();
    // Native filesystem sources finish registering after external setup. Prompt
    // hooks run after location plugins are ready and before selected-skill
    // resolution, so append the policy there. Each later filesystem reload
    // replays this final transform as well. Never accumulate per-turn filters.
    const hook = await context.session.hook("prompt", () => {
      refresh = refresh.then(async () => {
        const previous = registration;
        registration = await transform();
        await previous.dispose();
      });
      return refresh;
    });
    return async () => { await hook.dispose(); await refresh; await registration.dispose(); };
  },
};
