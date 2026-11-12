export type OpenCodeContext = {
  agent?: string;
  sessionID?: string;
  messageID?: string;
  directory?: string;
  worktree?: string;
  workspaceId?: string;
  workspaceID?: string;
  /** The engine's permission prompt in the calling chat; resolves only once the person allows. */
  ask?: (request: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void>;
};

type EngineMcpStatusRequest = {
  query?: {
    directory?: string;
  };
};

export type OpenWorkEngineMcpStatusClient = {
  mcp: {
    status: (request?: EngineMcpStatusRequest) => Promise<unknown>;
  };
};

export type OpenWorkEngineMcpStatusSource = {
  client?: OpenWorkEngineMcpStatusClient;
  directory?: string;
};


export const OPENWORK_LOCAL_SKILL_AUTHORING_INSTRUCTION =
  "Skill creation: Local. Create or update a requested skill in .opencode/skills/<skill-name>/SKILL.md, validate it, and re-read it after writing.";
export const OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION =
  "Use available configured MCP tools and local skills. For built-in extension actions, use openwork_query with id extension.actions, then openwork_execute with id extension.call for an exact returned action. Never invent unavailable tools or connections.";
export const OPENWORK_ON_DEMAND_DISCOVERY_INSTRUCTION = OPENWORK_LOCAL_SKILL_AUTHORING_INSTRUCTION;
export async function resolveOpenWorkExtensionDiscoveryInstruction(_input?: unknown, _fetcher?: unknown, _source?: OpenWorkEngineMcpStatusSource): Promise<string> {
  return OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION;
}
