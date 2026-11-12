import { getMcpServerName, isBuiltInOpenWorkExtension, type McpDirectoryInfo } from "../../../app/constants";
import { evaluateEnablement, type EnablementContext } from "../../../app/enablement";
import type { EnablementResult } from "../../../app/extensions";
import type { McpServerEntry, SkillCard } from "../../../app/types";
export type ExtensionInventoryGroup = "ready" | "available" | "disabled";
export type ExtensionResourceItem = { id: string; type: string; title: string; path?: string };
export type ExtensionItem = {
  id: string; source: "builtin" | "mcp-directory" | "skill"; name: string;
  description: string | null; installState: "available" | "installed";
  setupState: "ready" | "needs_setup" | "partial"; active: boolean;
  enablement: { active: boolean; results: EnablementResult[] } | null;
  resources: ExtensionResourceItem[]; builtInEntry?: McpDirectoryInfo;
  mcpEntry?: McpDirectoryInfo; skill?: { name: string; description?: string; path: string };
};
export function resolveExtensionInventoryGroup(item: ExtensionItem, options: { disabledReason?: string | null } = {}): ExtensionInventoryGroup {
  return options.disabledReason ? "disabled" : item.installState === "available" ? "available" : "ready";
}
export type ExtensionItemBuildInput = {
  quickConnect: McpDirectoryInfo[]; mcpServers: McpServerEntry[];
  installedSkills: Array<{ name: string; description?: string; path: string }>;
  enablementContext: EnablementContext; isBuiltInConnected: (entry: McpDirectoryInfo) => boolean;
};
export function isOpenworkProvidedSkill(skill: Pick<SkillCard, "name" | "path">) {
  return skill.path.replace(/\\/g, "/").toLowerCase().includes("/.opencode/skills/") &&
    ["workspace-guide", "skill-creator"].includes(skill.name.trim().toLowerCase());
}
function setupStateFromEnablement(enablement: { active: boolean; results: EnablementResult[] } | null): ExtensionItem["setupState"] {
  if (!enablement || !enablement.results.length) return "needs_setup";
  return enablement.active ? "ready" : enablement.results.some(result => result.met) ? "partial" : "needs_setup";
}
export function buildExtensionItems(input: ExtensionItemBuildInput) {
  const builtInItems = input.quickConnect.filter(isBuiltInOpenWorkExtension).map((entry): ExtensionItem => {
    const enablement = entry.extensionManifest?.enablement
      ? evaluateEnablement(entry.extensionManifest.enablement, input.enablementContext)
      : null;
    const active = enablement?.active ?? input.isBuiltInConnected(entry);
    return {
      id: `builtin:${entry.id ?? entry.serverName ?? entry.name}`,
      source: "builtin",
      name: entry.name,
      description: entry.description,
      installState: active ? "installed" : "available",
      setupState: enablement ? setupStateFromEnablement(enablement) : active ? "ready" : "needs_setup",
      active,
      enablement,
      resources: entry.extensionManifest?.resources.map((resource) => ({
        id: resource.id,
        type: resource.type,
        title: resource.label ?? resource.id,
        path: resource.path,
      })) ?? [],
      builtInEntry: entry,
    };
  });

  const standalone = input.quickConnect.filter(entry => !isBuiltInOpenWorkExtension(entry) && input.mcpServers.some(server => server.name === getMcpServerName(entry)));
  const skills: ExtensionItem[] = input.installedSkills.map(skill => ({
    id: `skill:${skill.name}`, source: "skill", name: skill.name, description: skill.description ?? null,
    installState: "installed", setupState: "ready", active: true, enablement: null,
    resources: [{ id: skill.name, type: "skill", title: skill.name, path: skill.path }], skill,
  }));
  const servers: ExtensionItem[] = standalone.map(entry => ({
    id: `mcp:${getMcpServerName(entry)}`, source: "mcp-directory", name: entry.name, description: entry.description,
    installState: "installed", setupState: "ready", active: true, enablement: null,
    resources: [{ id: getMcpServerName(entry), type: "mcp", title: entry.name }], mcpEntry: entry,
  }));
  return {
    items: [...builtInItems, ...servers, ...skills], builtInItems,
    installedMcpEntries: [...builtInItems.flatMap(item => item.active && item.builtInEntry ? [item.builtInEntry] : []), ...standalone],
    quickConnectEntries: [...builtInItems.flatMap(item => item.builtInEntry ? [item.builtInEntry] : []), ...standalone],
    installedSkills: input.installedSkills,
  };
}
