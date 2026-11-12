import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { opencodeV1DatabasePath, v1ChatDirectories, v1ChatDirectory } from "./opencode-history.js";
import { openRuntimeSqliteDatabase, runtimeDbPath, type RuntimeSqliteDatabase } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { isRecord } from "./workspace-kv-store.js";
import { resolveCompanyExecutionDirectory } from "./company-projects.js";

const databases = new Map<string, Promise<RuntimeSqliteDatabase>>();

async function database(config: ServerConfig) {
  const path = runtimeDbPath(config);
  let pending = databases.get(path);
  if (!pending) {
    pending = openRuntimeSqliteDatabase(path).then(db => {
      db.sqlite.exec(`CREATE TABLE IF NOT EXISTS opencode_v2_session_homes (
        session_id TEXT PRIMARY KEY NOT NULL, home_directory TEXT NOT NULL
      )`);
      return db;
    });
    databases.set(path, pending);
    void pending.catch(() => databases.delete(path));
  }
  return pending;
}

/** Where a chat copied from OpenCode v1 started. v1 chats never change folder,
 * so v1's own record is the origin even if the chat moved after the copy. */
export type V2SessionOrigin = (sessionId: string) => Promise<string | null>;

async function v1Origin(sessionId: string): Promise<string | null> {
  let database: string;
  try { database = opencodeV1DatabasePath(); } catch { return null; }
  return v1ChatDirectory(database, sessionId);
}

/** Reading a whole history is the slow path. A large migrated set must not run
 * hundreds of them against the engine at once, across all workspace lists. */
const HISTORY_SCAN_CONCURRENCY = 4;
let historyScans = 0;
const historyScanQueue: Array<() => void> = [];

async function withHistoryScanSlot<T>(scan: () => Promise<T>): Promise<T> {
  if (historyScans >= HISTORY_SCAN_CONCURRENCY) {
    await new Promise<void>(resolve => historyScanQueue.push(resolve));
  } else {
    historyScans++;
  }
  try { return await scan(); }
  finally {
    const next = historyScanQueue.shift();
    if (next) next();
    else historyScans--;
  }
}

function couldBeCompanyProject(company: string, directory: string): boolean {
  const parts = relative(company, directory).split(sep);
  return parts.length === 2 && parts[0] === "projects";
}

export function nativeSession(value: unknown): Record<string, unknown> | null {
  const data = isRecord(value) && "data" in value ? value.data : value;
  return isRecord(data) ? isRecord(data.info) ? data.info : data : null;
}

export function nativeSessionDirectory(value: unknown): string | null {
  const session = nativeSession(value);
  return isRecord(session?.location) && typeof session.location.directory === "string"
    ? session.location.directory : typeof session?.directory === "string" ? session.directory : null;
}

/** OpenWork owns the conversation's home; native location remains the execution
 * directory. Only engine history, or v1's record of a copied chat, can establish
 * an older session's original home.
 * Never adopt a caller-supplied workspace or a mutable metadata label as proof. */
export function createV2SessionHomes(
  config: ServerConfig,
  read: (path: string) => Promise<unknown>,
  origin: V2SessionOrigin = v1Origin,
) {
  const directories = new Map<string, Promise<string>>();
  const canonical = (directory: string) => {
    let pending = directories.get(directory);
    if (!pending) {
      pending = realpath(directory).catch(() => directory);
      directories.set(directory, pending);
    }
    return pending;
  };
  const stored = async (id: string): Promise<string | null> => {
    const db = await database(config);
    const row: unknown = db.sqlite.prepare("SELECT home_directory FROM opencode_v2_session_homes WHERE session_id = ?").get(id);
    return isRecord(row) && typeof row.home_directory === "string" ? row.home_directory : null;
  };
  const remember = async (id: string, directory: string) => {
    const home = await canonical(directory);
    const db = await database(config);
    db.sqlite.prepare("INSERT OR IGNORE INTO opencode_v2_session_homes (session_id, home_directory) VALUES (?, ?)").run(id, home);
    return (await stored(id)) ?? home;
  };
  const created = async (id: string, directory: string) => {
    const home = await canonical(directory);
    const db = await database(config);
    // Only a successful native creation may replace an old ID's binding.
    db.sqlite.prepare(`INSERT INTO opencode_v2_session_homes (session_id, home_directory) VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET home_directory = excluded.home_directory`).run(id, home);
    return home;
  };
  const list = async (directory: string): Promise<string[]> => {
    const db = await database(config);
    const rows = db.sqlite.prepare("SELECT session_id FROM opencode_v2_session_homes WHERE home_directory = ?").all(await canonical(directory));
    return rows.flatMap((row: unknown) => isRecord(row) && typeof row.session_id === "string" ? [row.session_id] : []);
  };
  const backfillUnmovedV1Homes = async (items: readonly unknown[], signal?: AbortSignal): Promise<void> => {
    if (!items.length || origin !== v1Origin) return;
    let v1Database: string;
    try { v1Database = opencodeV1DatabasePath(); } catch { return; }
    const db = await database(config);
    const read = db.sqlite.prepare("SELECT 1 FROM opencode_v2_session_homes WHERE session_id = ?");
    const unknownHomes = new Map<string, string>();
    for (const item of items) {
      const session = nativeSession(item);
      const directory = nativeSessionDirectory(item);
      if (typeof session?.id === "string" && typeof session.parentID !== "string"
        && directory && isAbsolute(directory) && !read.get(session.id)) unknownHomes.set(session.id, directory);
    }
    const copied = await v1ChatDirectories(v1Database, [...unknownHomes.keys()]);
    const verified = (await Promise.all([...copied].map(async ([id, original]) => {
      const home = await canonical(original);
      return await canonical(unknownHomes.get(id)!) === home ? { id, home } : null;
    }))).filter(item => item !== null);
    signal?.throwIfAborted();
    if (!verified.length) return;

    // Only exact v1 origins are prefilled here. Moved chats and descendants
    // still use the normal ownership proof and cannot inherit a native CWD.
    const insert = db.sqlite.prepare("INSERT OR IGNORE INTO opencode_v2_session_homes (session_id, home_directory) VALUES (?, ?)");
    db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const { id, home } of verified) insert.run(id, home);
      db.sqlite.exec("COMMIT");
    } catch (error) {
      db.sqlite.exec("ROLLBACK");
      throw error;
    }
  };
  const storedCompany = async (id: string, company: string): Promise<string | null> => {
    const existing = await stored(id);
    if (!existing) return null;
    const home = await canonical(company);
    const directory = await canonical(existing);
    if (!couldBeCompanyProject(home, directory)) return existing;
    const project = await resolveCompanyExecutionDirectory(home, existing);
    return project !== home && project === directory ? created(id, home) : existing;
  };
  const resolveCompany = async (value: unknown, company: string): Promise<string | null> => {
    const session = nativeSession(value);
    const directory = nativeSessionDirectory(value);
    if (!session || typeof session.id !== "string" || !directory) return null;
    const existing = await storedCompany(session.id, company);
    if (existing) return existing;
    const home = await canonical(company);
    const origin = await resolve(value);
    const execution = await canonical(directory);
    // Only an original project folder maps to its company. A conversation
    // moved here from another home never gains access from its mutable CWD.
    if (origin === execution && couldBeCompanyProject(home, execution)
      && await resolveCompanyExecutionDirectory(home, directory) !== home) return created(session.id, home);
    return origin;
  };
  const resolve = async (value: unknown, ancestors = new Set<string>()): Promise<string | null> => {
    const session = nativeSession(value);
    const directory = nativeSessionDirectory(value);
    if (!session || typeof session.id !== "string" || !directory) return null;
    const existing = await stored(session.id);
    if (existing) return existing;
    if (ancestors.has(session.id) || ancestors.size >= 256) throw new Error("Invalid conversation ancestry");
    const nextAncestors = new Set([...ancestors, session.id]);
    // Delegated sessions belong to the same conversation home even if they were
    // created after the parent moved into a worktree.
    if (typeof session.parentID === "string") {
      const parent = await resolve(await read(`/api/session/${encodeURIComponent(session.parentID)}`), nextAncestors);
      if (!parent) throw new Error("Could not verify the parent conversation");
      return remember(session.id, parent);
    }
    // Chats copied from v1 (often hundreds after a migration) are answered from
    // v1's own record without reading their history.
    const id = session.id;
    const copied = await origin(id).catch(() => null);
    if (copied) return remember(id, copied);
    // Backfill sessions created before this index existed, including moves made
    // while OpenWork was closed. Read oldest first; the first move records origin.
    const recorded = await withHistoryScanSlot(() => historyOrigin(id));
    return remember(id, recorded ?? directory);
  };
  const historyOrigin = async (id: string): Promise<string | null> => {
    let cursor: string | undefined;
    const seen = new Set<string>();
    while (true) {
      const query = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : { order: "asc" }) });
      const page = await read(`/api/session/${encodeURIComponent(id)}/message?${query}`);
      const items = Array.isArray(page) ? page : isRecord(page) ? page.data : null;
      if (!Array.isArray(items)) throw new Error("Could not verify the conversation's original folder");
      for (const item of items) {
        if (!isRecord(item) || item.type !== "location-switched") continue;
        const content = isRecord(item.data) ? item.data : item;
        const previous = isRecord(content.previous) ? content.previous : null;
        const location = previous && isRecord(previous.location) ? previous.location : null;
        if (typeof location?.directory !== "string") throw new Error("Invalid conversation move history");
        return location.directory;
      }
      const next = isRecord(page) && isRecord(page.cursor) ? page.cursor.next : undefined;
      if (next === undefined || next === null) break;
      if (typeof next !== "string" || seen.has(next)) throw new Error("Invalid conversation history cursor");
      seen.add(next);
      cursor = next;
    }
    return null;
  };
  const project = async (value: unknown, verifiedHome?: string) => {
    const home = verifiedHome ?? await resolve(value);
    const session = nativeSession(value);
    const directory = nativeSessionDirectory(value);
    if (!session || !home || !directory) return value;
    const info = { ...session, directory: home, openworkHomeDirectory: home, executionDirectory: directory };
    return isRecord(value) && isRecord(value.info) ? { ...value, info } : info;
  };
  return { canonical, stored, storedCompany, remember, created, resolve, resolveCompany, list, project, backfillUnmovedV1Homes };
}
