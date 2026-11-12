import { lstat, readFile } from "node:fs/promises";
import { runtimeIdForConfig, runtimeTokenForConfig } from "./runtime-session-context.js";
import { loopbackFetch } from "./server-fetch.js";
import type { ServerConfig } from "./types.js";
import { setTimeout as delay } from "node:timers/promises";
import { BoundedSseFrameBuffer } from "./engine-pool.js";
import { isRecord } from "./workspace-kv-store.js";

export type LeaseRelease = { sessionId?: string; reason: "turn_end" | "abort" | "deleted" | "runtime_stop"; observedAt?: number };
export type LeaseEventTarget = { key: string; url: string; headers: Record<string, string> };

export function leaseLifecycleEvent(value: unknown): LeaseRelease | null {
  const event = isRecord(value) && isRecord(value.payload) ? value.payload : value;
  if (!isRecord(event)) return null;
  const data = isRecord(event.properties) ? event.properties : isRecord(event.data) ? event.data : {};
  const info = isRecord(data.info) ? data.info : data;
  const sessionId = typeof data.sessionID === "string" ? data.sessionID : typeof info.id === "string" ? info.id : undefined;
  if (!sessionId?.startsWith("ses_")) return null;
  if (event.type === "session.deleted" || event.type === "session.archived" || (event.type === "session.updated" && isRecord(info.time) && Number(info.time.archived) > 0)) return { sessionId, reason: "deleted" };
  if (event.type === "session.execution.interrupted") return { sessionId, reason: "abort" };
  if (["session.idle", "session.execution.succeeded", "session.execution.failed"].includes(String(event.type))
    || event.type === "session.status" && isRecord(data.status) && data.status.type === "idle") return { sessionId, reason: "turn_end" };
  return null;
}

/** Watches native event streams independently of any renderer or chat tab. */
export function createAiopcLeaseLifecycle(options: {
  targets: () => LeaseEventTarget[];
  release: (value: LeaseRelease) => Promise<void>;
  verifyIdle?: (target: LeaseEventTarget, sessionId: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  reportError?: (error: unknown) => void;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const watches = new Map<string, { controller: AbortController; task: Promise<void> }>();
  let stopped = false;
  const consume = async (target: LeaseEventTarget, signal: AbortSignal) => {
    while (!signal.aborted) {
      try {
        const response = await fetchImpl(target.url, { headers: target.headers, signal });
        if (!response.ok || !response.body) throw new Error(`Native event stream unavailable (${response.status})`);
        const reader = response.body.getReader();
        const buffer = new BoundedSseFrameBuffer();
        try {
          while (!signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const result = buffer.push(chunk.value);
            if (result.overflow) throw new Error("Native event frame exceeded limit");
            for (const frame of result.frames) {
              const raw = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
              let event: unknown; try { event = JSON.parse(raw); } catch { continue; }
              const release = leaseLifecycleEvent(event); if (!release?.sessionId) continue;
              // Capture before any HTTP await. A newer begin/heartbeat prevents a delayed release.
              const native = isRecord(event) && isRecord(event.payload) ? event.payload : event;
              const data = isRecord(native) && isRecord(native.data) ? native.data : {};
              const stamp = isRecord(native) ? (typeof data.timestamp === "number" ? data.timestamp : native.created) : undefined;
              const observedAt = typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0 ? stamp : Date.now();
              if (release.reason === "turn_end" && options.verifyIdle && !await options.verifyIdle(target, release.sessionId)) continue;
              await options.release({ ...release, observedAt });
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch (error) { if (!signal.aborted) options.reportError?.(error); }
      await delay(options.pollMs ?? 1_000, undefined, { signal }).catch(() => {});
    }
  };
  const refresh = () => {
    if (stopped) return;
    const current = new Map(options.targets().map(target => [target.key, target]));
    for (const [key, value] of watches) if (!current.has(key)) { value.controller.abort(); watches.delete(key); }
    for (const [key, target] of current) {
      if (watches.has(key)) continue;
      const controller = new AbortController();
      watches.set(key, { controller, task: consume(target, controller.signal) });
    }
  };
  const timer = setInterval(refresh, options.pollMs ?? 1_000); timer.unref?.(); refresh();
  return { async stop() {
    stopped = true; clearInterval(timer);
    const current = [...watches.values()]; for (const watch of current) watch.controller.abort();
    await Promise.all(current.map(watch => watch.task)); watches.clear();
    await options.release({ reason: "runtime_stop", observedAt: Date.now() });
  } };
}


/** Reads a private connection descriptor afresh so a restarted OPC service is found. */
export function createAiopcLeaseReleaser(config: ServerConfig, file = process.env.AIOPC_HTTP_CONNECTION_FILE) {
  return async (value: LeaseRelease): Promise<void> => {
    if (!file) return;
    const info = await lstat(file);
    if (!info.isFile() || (process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid?.()))) {
      throw new Error("Insecure OPC HTTP connection descriptor");
    }
    const connection: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isRecord(connection) || typeof connection.url !== "string" || typeof connection.token !== "string" || !connection.token) throw new Error("Invalid OPC HTTP connection descriptor");
    const url = new URL(connection.url);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("OPC lifecycle target must be loopback");
    url.pathname = "/api/runtime/release"; url.search = ""; url.hash = "";
    const response = await loopbackFetch(url.toString(), { method: "POST", signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${connection.token}`, "x-aiopc-runtime-token": runtimeTokenForConfig(config), "content-type": "application/json" },
      body: JSON.stringify({ ...value, runtimeId: runtimeIdForConfig(config) }),
    });
    if (!response.ok) throw new Error(`OPC lease release rejected (${response.status})`);
    await response.body?.cancel();
  };
}
