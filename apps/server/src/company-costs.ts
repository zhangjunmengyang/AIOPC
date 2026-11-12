import type { CompanyCostGroup, CompanyCostReport, CompanyCostSession, CompanyCostUsage } from "@openwork/types/company-costs";
import { nativeSession } from "./opencode-v2-session-home.js";
import { nativeSessionUsage } from "./session-read-detail.js";
import type { SessionMetadata } from "./session-groups.js";
import { isRecord } from "./workspace-kv-store.js";

type Engine = "v1" | "v2";

/** Calls the authenticated company-scoped proxy. null means the engine is disabled. */
export type ReadCostEngine = (engine: Engine, path: string) => Promise<Response | null>;

type ListedSession = Pick<CompanyCostSession, "id" | "title" | "projectId"> & {
  engine: Engine;
  nativeRole: string | null;
};

const ENGINES = ["v1", "v2"] as const;
const PAGE_SIZE = 200;
const SESSION_READ_CONCURRENCY = 6;

function emptyUsage(): CompanyCostUsage {
  return { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, events: 0, unpricedEvents: 0 };
}

function addUsage(target: CompanyCostUsage, source: CompanyCostUsage) {
  for (const key of Object.keys(target) as Array<keyof CompanyCostUsage>) {
    target[key] += source[key];
  }
}

/** The v1 inventory uses a limit but no cursor. Its default returns only 100 per folder. */
async function* readPages(
  read: ReadCostEngine, engine: Engine, path: string, kind: "list" | "messages", signal: AbortSignal,
): AsyncGenerator<unknown[] | null> {
  const url = new URL(path, "http://native");
  const seen = new Set<string>();
  const legacyList = engine === "v1" && kind === "list";
  url.searchParams.set("limit", legacyList ? "2147483647" : String(PAGE_SIZE));
  while (true) {
    signal.throwIfAborted();
    const response = await read(engine, url.pathname + url.search);
    if (response === null && seen.size === 0 && kind === "list") {
      yield null;
      return;
    }
    if (!response?.ok) {
      await response?.body?.cancel();
      throw new Error("Could not read native session usage");
    }
    const payload: unknown = await response.json();
    const rows = engine === "v2" && isRecord(payload) ? payload.data : payload;
    const items = Array.isArray(rows) ? rows : isRecord(rows) ? rows.items : null;
    if (!Array.isArray(items)) throw new Error("Invalid native session usage response");
    yield items;
    const next = engine === "v1" ? response.headers.get("X-Next-Cursor")
      : isRecord(payload) && isRecord(payload.cursor) ? payload.cursor.next : null;
    if (next === null || next === undefined) return;
    if (typeof next !== "string" || !next || !items.length || seen.has(next)) {
      throw new Error("Invalid native session usage cursor");
    }
    seen.add(next);
    url.searchParams.delete("order");
    url.searchParams.set(engine === "v1" ? "before" : "cursor", next);
  }
}

async function listSessions(read: ReadCostEngine, engine: Engine, signal: AbortSignal) {
  const items = new Map<string, ListedSession>();
  try {
    for await (const page of readPages(read, engine, engine === "v1" ? "/session" : "/api/session", "list", signal)) {
      if (page === null) return { items, status: "disabled" as const };
      for (const row of page) {
        const session = nativeSession(row);
        if (!session || typeof session.id !== "string" || !/^ses_[\w-]+$/.test(session.id)) {
          throw new Error("Invalid session in company inventory");
        }
        const { id, projectId } = session;
        if (projectId !== null && !(typeof projectId === "string" && projectId.startsWith("proj:"))) {
          throw new Error("Unverified company session project");
        }
        if (items.has(id)) continue;
        items.set(id, {
          id, projectId, engine,
          title: typeof session.title === "string" && session.title.trim() ? session.title : id,
          nativeRole: typeof session.agent === "string" && session.agent.trim() ? session.agent.trim() : null,
        });
      }
    }
    return { items, status: "ready" as const };
  } catch {
    signal.throwIfAborted();
    return { items, status: "unavailable" as const };
  }
}

async function readSessionUsage(read: ReadCostEngine, session: ListedSession, meta: SessionMetadata | undefined, signal: AbortSignal): Promise<CompanyCostSession> {
  const { id, engine, title, projectId } = session;
  const path = `/session/${encodeURIComponent(id)}/message`;
  const endpoint = engine === "v1" ? path : `/api${path}?order=desc`;
  const seenMessages = new Set<string>();
  const seenEvents = new Set<string>();
  const usage = emptyUsage();
  let role = meta?.agentName ?? session.nativeRole;
  for await (const rows of readPages(read, engine, endpoint, "messages", signal)) {
    if (!rows) throw new Error("Native message history is unavailable");
    // v1 pages are chronological within each page; both cursors walk back in time.
    const newestFirst = engine === "v1" ? rows.reverse() : rows;
    for (const row of newestFirst) {
      const info = engine === "v1" && isRecord(row) ? row.info : row;
      if (!isRecord(info) || (info.sessionID !== undefined && info.sessionID !== id)) {
        throw new Error("Message belongs to a different session");
      }
      const message = nativeSessionUsage(row, engine);
      if (!message?.events.length || seenMessages.has(message.id)) continue;
      seenMessages.add(message.id);
      role ??= message.agent?.trim() || null;
      for (const event of message.events) {
        if (seenEvents.has(event.id)) continue;
        seenEvents.add(event.id);
        addUsage(usage, {
          cost: event.cost ?? 0,
          input: event.tokens?.input ?? 0,
          output: event.tokens?.output ?? 0,
          reasoning: event.tokens?.reasoning ?? 0,
          cacheRead: event.tokens?.cache?.read ?? 0,
          cacheWrite: event.tokens?.cache?.write ?? 0,
          events: 1,
          unpricedEvents: event.cost === undefined ? 1 : 0,
        });
      }
    }
  }
  return { id, title, projectId, role, usage };
}

function groupCosts(rows: CompanyCostSession[], dimension: "role" | "projectId"): CompanyCostGroup[] {
  const groups = new Map<string | null, CompanyCostUsage>();
  for (const row of rows) {
    const id = row[dimension];
    const usage = groups.get(id) ?? emptyUsage();
    addUsage(usage, row.usage);
    groups.set(id, usage);
  }
  return [...groups].map(([id, usage]) => ({ id, usage }))
    .sort((a, b) => b.usage.cost - a.usage.cost || (a.id ?? "").localeCompare(b.id ?? ""));
}

export async function readCompanyCosts(
  read: ReadCostEngine,
  readSessionMeta: () => Promise<Record<string, SessionMetadata>>,
  signal: AbortSignal,
): Promise<CompanyCostReport> {
  const [v1, v2] = await Promise.all(ENGINES.map(engine => listSessions(read, engine, signal)));
  // Converted histories can be visible in both generations. The v2 history is the
  // authoritative copy and may contain additional turns or regrouped v1 messages.
  const sessions = [...new Map([...v1.items, ...v2.items]).values()];
  const meta = await readSessionMeta();
  const bySession: CompanyCostSession[] = [];
  let unreadableSessions = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(SESSION_READ_CONCURRENCY, sessions.length) }, async () => {
    while (next < sessions.length) {
      const session = sessions[next++];
      try {
        bySession.push(await readSessionUsage(read, session, meta[session.id], signal));
      } catch {
        signal.throwIfAborted();
        unreadableSessions++;
      }
    }
  }));
  signal.throwIfAborted();
  bySession.sort((a, b) => b.usage.cost - a.usage.cost || a.id.localeCompare(b.id));
  const totals = emptyUsage();
  for (const row of bySession) addUsage(totals, row.usage);
  return {
    totals, bySession,
    byRole: groupCosts(bySession, "role"),
    byProject: groupCosts(bySession, "projectId"),
    sources: { v1: v1.status, v2: v2.status },
    unreadableSessions,
  };
}
