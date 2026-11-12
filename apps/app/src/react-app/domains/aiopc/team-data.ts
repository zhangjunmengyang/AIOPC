export type TeamRole = {
  id: string;
  name: string;
  description: string;
  reportsTo: string | null;
  skills: string[];
};

export type TeamSessionMeta = Record<string, { agentName?: string; projectId?: string | null }>;
export type TeamSessionSummary = {
  id: string;
  title: string;
  time: { updated: number; archived?: number };
};
export type TeamSession = { id: string; title: string; projectId: string | null; updated: number };
export type TeamStatus = "working" | "waiting" | "idle" | "unknown";

export type TeamMember = {
  role: TeamRole;
  status: TeamStatus;
  currentSession: TeamSession | null;
  sessions: TeamSession[];
};

export type TeamProject = { id: string; name: string; directory: string; skills: string[] };
export type TeamProjectListing = { id: string; name: string; path: string };
export type TeamTask = {
  id: string;
  title: string;
  assignee: string | null;
  status: "todo" | "in_progress" | "in_review" | "done" | "blocked";
  deliverables: Array<{ kind: "file" | "publish"; path: string; label?: string | null }>;
  updatedAt: string;
  activity?: Array<{ at: string; fields: string[] }>;
};
export type TeamPublishRecord = {
  at: number;
  platform: string;
  status: string;
  session_id?: string;
  url?: string;
};
export type TeamOutputProject = Pick<TeamProject, "id" | "name" | "directory"> & {
  tasks: TeamTask[];
  history: TeamPublishRecord[];
};

type OutputBase = { id: string; project: Pick<TeamProject, "id" | "name" | "directory">; at: number };
export type TeamOutput = OutputBase & (
  | { kind: "task"; task: TeamTask }
  | { kind: "publish"; record: TeamPublishRecord }
);

export function teamProjectsForCompany(
  projects: readonly TeamProjectListing[],
  projectSkills: Record<string, string[]> | undefined,
): TeamProject[] {
  if (!projectSkills) return [];
  return projects.flatMap(({ id, name, path }) => Object.hasOwn(projectSkills, id)
    ? [{ id, name, directory: path, skills: projectSkills[id]! }]
    : []);
}

export function teamCardSkillNames(member: TeamMember, projects: ReadonlyArray<Pick<TeamProject, "id" | "skills">>) {
  const project = projects.find((item) => item.id === member.currentSession?.projectId);
  return [...new Set([...member.role.skills, ...(project?.skills ?? [])])];
}

export function buildTeamRoster(
  roles: TeamRole[],
  metadata: TeamSessionMeta,
  sessions: readonly TeamSessionSummary[],
  statuses: { active: ReadonlySet<string> | null; waiting: ReadonlySet<string> | null },
): TeamMember[] {
  const { active, waiting } = statuses;
  const knownSessions = new Map(sessions.map((session) => [session.id, session]));
  const byRole = new Map<string, TeamSession[]>();
  for (const [id, meta] of Object.entries(metadata)) {
    if (!meta.agentName) continue;
    const session = knownSessions.get(id);
    if (session?.time.archived || (!session && !active?.has(id) && !waiting?.has(id))) continue;
    const entries = byRole.get(meta.agentName) ?? [];
    entries.push({
      id, title: session?.title ?? "", projectId: meta.projectId ?? null, updated: session?.time.updated ?? 0,
    });
    byRole.set(meta.agentName, entries);
  }
  const priority = (id: string) => waiting?.has(id) ? 2 : active?.has(id) ? 1 : 0;
  return roles.map((role) => {
    const sessions = (byRole.get(role.id) ?? []).sort((a, b) => priority(b.id) - priority(a.id) || b.updated - a.updated);
    const current = sessions[0];
    const status = current && waiting?.has(current.id) ? "waiting"
      : current && active?.has(current.id) ? "working"
        : active && waiting ? "idle" : "unknown";
    return { role, status, currentSession: status === "working" || status === "waiting" ? current ?? null : null, sessions };
  });
}

type TeamMessage = {
  info: { role: string; time: { created: number } };
  parts: ReadonlyArray<{
    type: string;
    tool?: string;
    state?: { status?: string; title?: string; time?: { start?: number } };
  }>;
};

export function latestTeamToolTitle(messages: readonly TeamMessage[]): string | null {
  let latestAt = -Infinity;
  let title: string | null = null;
  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "tool" || !part.state || !part.tool) continue;
      const at = part.state.time?.start ?? message.info.time.created;
      if (at < latestAt) continue;
      latestAt = at;
      title = part.state.title?.trim() || part.tool;
    }
  }
  return title;
}

export function startOfTeamWeek(now: Date) {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  return monday.getTime();
}

export function buildTeamOutputs(
  projects: TeamOutputProject[],
  metadata: TeamSessionMeta,
  roles: ReadonlySet<string>,
  since: number,
) {
  const byRole = new Map<string, TeamOutput[]>();
  const unattributed: TeamOutput[] = [];
  const add = (output: TeamOutput, role?: string | null) => {
    if (!role || !roles.has(role)) {
      if (output.kind === "publish") unattributed.push(output);
      return;
    }
    const entries = byRole.get(role) ?? [];
    entries.push(output);
    byRole.set(role, entries);
  };

  for (const { id, name, directory, tasks, history } of projects) {
    const project = { id, name, directory };
    for (const task of tasks) {
      const lastDelivery = task.activity?.findLast((entry) => entry.fields.includes("deliverables"));
      const at = Date.parse(lastDelivery?.at ?? "");
      if (at >= since && task.deliverables.length) {
        add({ id: `${id}:task:${task.id}`, project, at, kind: "task", task }, task.assignee);
      }
    }
    for (const [index, record] of history.entries()) {
      const at = record.at * 1_000;
      if (!(at >= since) || !["published", "composer_filled", "composer_opened"].includes(record.status)) continue;
      const source = record.session_id ? metadata[record.session_id] : undefined;
      add(
        { id: `${id}:publish:${at}:${index}`, project, at, kind: "publish", record },
        source && (source.projectId ?? null) === (id || null) ? source.agentName : undefined,
      );
    }
  }
  for (const entries of [...byRole.values(), unattributed]) entries.sort((a, b) => b.at - a.at);
  return { byRole, unattributed };
}
