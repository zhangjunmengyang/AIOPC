import { listCompanyProjects } from "./company-projects.js";
import { ApiError } from "./errors.js";
import { nativeSessionDirectory, type createV2SessionHomes } from "./opencode-v2-session-home.js";
import { isRecord } from "./workspace-kv-store.js";

type Homes = ReturnType<typeof createV2SessionHomes>;
type Kind = "status" | "pending";

function pendingItems(payload: unknown): { key: string | null; items: unknown[] } {
  if (Array.isArray(payload)) return { key: null, items: payload };
  if (isRecord(payload)) {
    for (const key of ["items", "permissions", "questions", "requests"]) {
      if (Array.isArray(payload[key])) return { key, items: payload[key] };
    }
  }
  return { key: null, items: [] };
}

function field(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) if (typeof value[key] === "string" && value[key]) return value[key] as string;
  return null;
}

const sessionId = (item: Record<string, unknown>) => field(item, ["sessionID", "sessionId", "session_id"]);
const requestId = (item: Record<string, unknown>) => field(item, ["id", "requestID", "requestId", "permissionID", "questionID"]);

/** Native v1 pending requests live in execution instances; the UI lives at the company. */
export function createCompanySessionPending(input: {
  company: string;
  homes: Homes;
  readSession: (id: string) => Promise<unknown>;
  readPending: (path: string, directory: string, kind: Kind) => Promise<unknown>;
  signal?: AbortSignal;
}) {
  const sessionReads = new Map<string, Promise<unknown>>();
  const readSession = (id: string) => {
    let result = sessionReads.get(id);
    if (!result) { result = input.readSession(id); sessionReads.set(id, result); }
    return result;
  };
  const owns = async (id: string): Promise<boolean> => {
    try {
      const home = await input.homes.storedCompany(id, input.company)
        ?? await input.homes.resolveCompany(await readSession(id), input.company);
      return home === await input.homes.canonical(input.company);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      return false;
    }
  };
  const directories = async () => {
    const result = new Set([await input.homes.canonical(input.company),
      ...(await listCompanyProjects(input.company)).map(project => project.directory)]);
    for (const id of await input.homes.list(input.company)) {
      try {
        const directory = nativeSessionDirectory(await readSession(id));
        if (directory) result.add(await input.homes.canonical(directory));
      } catch (error) {
        if (input.signal?.aborted) throw error;
      }
    }
    return [...result];
  };

  async function aggregate(path: string, kind: Kind): Promise<unknown> {
    const pending = new Map<string, unknown>();
    const statuses: Record<string, unknown> = {};
    let firstPayload: unknown;
    let containerKey: string | null = null;
    for (const [index, directory] of (await directories()).entries()) {
      let payload: unknown;
      try { payload = await input.readPending(path, directory, kind); }
      catch (error) {
        if (input.signal?.aborted || index === 0 || !(error instanceof ApiError)) throw error;
        continue;
      }
      if (index === 0) firstPayload = payload;
      if (kind === "status") {
        if (isRecord(payload)) for (const [id, status] of Object.entries(payload)) {
          if (await owns(id)) statuses[id] = status;
        }
      } else {
        const parsed = pendingItems(payload);
        containerKey ??= parsed.key;
        for (const item of parsed.items) {
          if (!isRecord(item)) continue;
          const owner = sessionId(item), id = requestId(item);
          if (owner && id && await owns(owner)) pending.set(id, item);
        }
      }
    }
    if (kind === "status") return statuses;
    return containerKey && isRecord(firstPayload)
      ? { ...firstPayload, [containerKey]: [...pending.values()] } : [...pending.values()];
  }

  async function replyDirectory(kind: "permission" | "question", id: string): Promise<string> {
    const items = pendingItems(await aggregate(`/${kind}`, "pending")).items;
    const item = items.find(item => isRecord(item) && requestId(item) === id);
    const owner = isRecord(item) ? sessionId(item) : null;
    if (!owner) throw new ApiError(404, "request_not_found", "This company's pending request was not found");
    const directory = nativeSessionDirectory(await readSession(owner));
    if (!directory || !await owns(owner)) throw new ApiError(404, "request_not_found", "This company's pending request was not found");
    return directory;
  }

  return { aggregate, replyDirectory };
}
