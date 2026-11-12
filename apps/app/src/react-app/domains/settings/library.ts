/**
 * Library is the single inventory for composer capabilities.
 * Configure from the + menu, and the agents / commands / skills lists,
 * all resolve through this module so settings routes cannot drift.
 */
/** Unfiltered Library inventory. */
export const LIBRARY_ROUTE_PATH = "";

export const LIBRARY_COMPOSER_KINDS = ["agents", "commands", "skills"] as const;

export type LibraryComposerKind = (typeof LIBRARY_COMPOSER_KINDS)[number];

export type ComposerSettingsSection =
  | LibraryComposerKind
  | "mcps"
  | "plugins"
  | "connections"
  | "extensions"
  | "providers";

/** Fallback when Configure has no + menu section (opens the full inventory). */
export const COMPOSER_CONFIGURE_SECTION = "extensions" satisfies ComposerSettingsSection;

export function isLibraryComposerKind(section: string): section is LibraryComposerKind {
  return (LIBRARY_COMPOSER_KINDS as readonly string[]).includes(section);
}

/** Map a composer + menu pane onto the Library settings section. */
export function composerConfigureSectionForMenu(section: string): ComposerSettingsSection {
  if (section === "mcps") return "connections";
  if (
    section === "providers"
    || section === "extensions"
    || section === "plugins"
    || section === "connections"
  ) {
    return section;
  }
  if (isLibraryComposerKind(section)) return section;
  if (section.startsWith("plugin:")) return "plugins";
  return COMPOSER_CONFIGURE_SECTION;
}

/** URL tail under /extensions for a composer Configure destination. */
export function libraryPathForSection(section: ComposerSettingsSection): string {
  if (section === "providers" || section === "extensions") return LIBRARY_ROUTE_PATH;
  return section;
}

export const LIBRARY_COMMAND_DETAIL_PREFIX = "command:";
export const LIBRARY_AGENT_DETAIL_PREFIX = "agent:";

export type LibraryCommandItem = {
  id: string;
  name: string;
  description?: string;
  template?: string;
  hints?: string[];
  agent?: string;
  model?: string;
  subtask?: boolean;
};

export type LibraryAgentItem = {
  name: string;
  description?: string;
  prompt?: string;
  mode?: string;
  native?: boolean;
  model?: {
    providerID: string;
    modelID: string;
  };
};

export function libraryCommandDetailId(command: Pick<LibraryCommandItem, "id">) {
  return `${LIBRARY_COMMAND_DETAIL_PREFIX}${command.id}`;
}

export function libraryAgentDetailId(agent: Pick<LibraryAgentItem, "name">) {
  return `${LIBRARY_AGENT_DETAIL_PREFIX}${agent.name}`;
}

export function parseLibraryCommandDetailId(detailId: string) {
  if (!detailId.startsWith(LIBRARY_COMMAND_DETAIL_PREFIX)) return null;
  return detailId.slice(LIBRARY_COMMAND_DETAIL_PREFIX.length);
}

export function parseLibraryAgentDetailId(detailId: string) {
  if (!detailId.startsWith(LIBRARY_AGENT_DETAIL_PREFIX)) return null;
  return detailId.slice(LIBRARY_AGENT_DETAIL_PREFIX.length);
}

export function libraryCommandTriggers(command: LibraryCommandItem) {
  const slash = `/${command.name}`;
  const extras = (command.hints ?? []).map((hint) => hint.trim()).filter((hint) => hint.length > 0 && hint !== slash);
  return [slash, ...extras];
}

export function isLibraryCommand(command: { source?: string | null }) {
  return !command.source || command.source === "command";
}

export function isLibraryAgent(agent: { hidden?: boolean; mode?: string | null }) {
  return !agent.hidden && agent.mode !== "subagent";
}

export function libraryCommandsFromSlashOptions(
  commands: Array<{
    id: string;
    name: string;
    description?: string;
    source?: string | null;
    template?: string;
    hints?: string[];
    agent?: string;
    model?: string;
    subtask?: boolean;
  }>,
): LibraryCommandItem[] {
  return commands.filter(isLibraryCommand).map((command) => ({
    id: command.id,
    name: command.name,
    description: command.description,
    template: command.template,
    hints: command.hints,
    agent: command.agent,
    model: command.model,
    subtask: command.subtask,
  }));
}

export function libraryAgentsFromOpencode(
  agents: Array<{
    name: string;
    description?: string;
    hidden?: boolean;
    mode?: string | null;
    prompt?: string;
    native?: boolean;
    model?: { providerID: string; modelID: string };
  }>,
): LibraryAgentItem[] {
  return agents.filter(isLibraryAgent).map((agent) => ({
    name: agent.name,
    description: agent.description,
    prompt: agent.prompt,
    mode: agent.mode ?? undefined,
    native: agent.native,
    model: agent.model,
  }));
}

export type ComposerConfigureDestination =
  | { kind: "library"; path: string }
  | { kind: "settings"; route: "/settings/ai" };

/** Configure from the composer opens the matching Library filter, except providers. */
export function composerConfigureDestination(
  section: ComposerSettingsSection,
): ComposerConfigureDestination {
  if (section === "providers") return { kind: "settings", route: "/settings/ai" };
  return { kind: "library", path: libraryPathForSection(section) };
}

export function openComposerConfigure(
  section: ComposerSettingsSection,
  handlers: {
    openLibrary: (path?: string) => void;
    openSettings: (route: string) => void;
  },
) {
  const destination = composerConfigureDestination(section);
  if (destination.kind === "settings") {
    handlers.openSettings(destination.route);
    return;
  }
  handlers.openLibrary(destination.path);
}

export const LIBRARY_ADD_KINDS = ["skill", "command", "agent", "mcp", "workspace-mcp", "plugin", "connection"] as const;
export type LibraryAddKind = (typeof LIBRARY_ADD_KINDS)[number];
export type LibraryAuthorableKind = "skill" | "command" | "agent";
const LIBRARY_ITEM_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export type CreateLibraryItemInput = { name: string; description: string; instructions: string };
export function libraryAddKindsForFilter(filter: string): LibraryAddKind[] {
  if (filter === "all") return ["skill", "command", "agent", "workspace-mcp"];
  if (filter === "skill") return ["skill", "command", "agent"];
  if (filter === "mcp" || filter === "connection") return ["workspace-mcp"];
  if (filter === "command" || filter === "agent") return [filter];
  return [];
}
export function isLibraryAuthorableKind(kind: LibraryAddKind): kind is LibraryAuthorableKind {
  return kind === "skill" || kind === "command" || kind === "agent";
}
export function parseSkillMarkdown(raw: string): { name: string; description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { name: "", description: "", body: raw.trim() };
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      const value = line.slice(separator + 1).trim();
      let decoded = value;
      if (value.startsWith('"')) { try { decoded = JSON.parse(value); } catch {} }
      fields.set(line.slice(0, separator).trim(), decoded);
    }
  }
  return {
    name: fields.get("name") ?? "",
    description: fields.get("description") ?? "",
    body: (match[2] ?? "").trim(),
  };
}

export function skillMarkdown(name: string, description: string, instructions: string) {
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    instructions,
    "",
  ].join("\n");
}

export function slugifyLibraryItemName(name: string, fallback: LibraryAuthorableKind): string {
  let base = name
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) base = fallback;
  if (base.length > 64) base = base.slice(0, 64).replace(/-+$/g, "");
  if (!LIBRARY_ITEM_NAME_RE.test(base)) return fallback;
  return base;
}
