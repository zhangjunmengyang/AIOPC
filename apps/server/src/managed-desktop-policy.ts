import type { DesktopConfig } from "@openwork/types/desktop-policies-runtime";
import type { AgentPermissionAction, AgentPermissionRule } from "@openwork/types/agent-permissions-runtime";
import type { ServerConfig } from "./types.js";

/** Local workspaces have no organization policy or remote policy authority. */
export function agentPermissionRulesForActions(rules: readonly AgentPermissionRule[], actions: readonly AgentPermissionAction[]): AgentPermissionRule[] {
  return rules.filter((rule) => actions.includes(rule.action));
}

const policy = {
  evaluationToken: "",
  onChange: undefined as (() => void) | undefined,
  onV2OnlyChange: undefined as ((enabled: boolean) => void) | undefined,
  authenticatesEvaluation(_request: Request): boolean { return false; },
  async setSession(_session: unknown): Promise<void> {},
  async clearSession(): Promise<void> {},
  async current(): Promise<DesktopConfig | null> { return null; },
  known(): DesktopConfig | null { return null; },
  async assertLegacyExecutionRequest(_request: Request, _path: string): Promise<void> {},
  async assertRequest(_request: Request, _path: string, _engine = false): Promise<void> {},
  async assertAgentPermission(_action: "skill" | "mcp", _name: string): Promise<void> {},
  async assert(_action: string, _input: Record<string, unknown> = {}): Promise<void> {},
  async remoteComputersEnabled(): Promise<boolean> { return true; },
  async standardCodeModeEnabled(): Promise<boolean> { return false; },
  async browserUploadPolicy() { return { enabled: false, scope: null, rules: [] as AgentPermissionRule[] }; },
  async websiteRules(): Promise<AgentPermissionRule[]> { return []; },
  async computerRules(): Promise<AgentPermissionRule[]> { return []; },
};

export function managedDesktopPolicy(_config: ServerConfig) { return policy; }
