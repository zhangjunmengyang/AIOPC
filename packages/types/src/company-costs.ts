/** Totals from native OpenCode model usage records. Cost is the engine's USD estimate. */
export type CompanyCostUsage = {
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  events: number;
  unpricedEvents: number;
};

export type CompanyCostGroup = {
  id: string | null;
  usage: CompanyCostUsage;
};

export type CompanyCostSession = {
  id: string;
  title: string;
  role: string | null;
  projectId: string | null;
  usage: CompanyCostUsage;
};

export type CompanyCostReport = {
  totals: CompanyCostUsage;
  bySession: CompanyCostSession[];
  byRole: CompanyCostGroup[];
  byProject: CompanyCostGroup[];
  sources: Record<"v1" | "v2", "ready" | "disabled" | "unavailable">;
  unreadableSessions: number;
};
