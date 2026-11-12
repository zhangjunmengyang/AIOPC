import { expect, test } from "bun:test";
import { readCompanyCosts, type ReadCostEngine } from "../src/company-costs.js";

const v1Assistant = (id: string, sessionID: string, cost: number) => ({
  info: {
    id, sessionID, role: "assistant", agent: "legacy-native", cost,
    tokens: { input: 10, output: 3, reasoning: 2, cache: { read: 4, write: 5 } },
  },
  parts: [{ id: `${id}-finish`, type: "step-finish", cost,
    tokens: { input: 10, output: 3, reasoning: 2, cache: { read: 4, write: 5 } } }],
});
const v2Event = (id: string, type: string, cost?: number, input?: number) => ({
  id, type, sessionID: "ses_moved", agent: "native-role", cost,
  ...(input !== undefined ? { tokens: { input, output: 0 } } : {}),
});
const nativePage = (data: unknown[], next?: string) => Response.json({ data, cursor: { next: next ?? null } });

test("costs use company-owned session metadata, count both native engines and deduplicate overlapping pages", async () => {
  const read: ReadCostEngine = async (engine, path) => {
    const url = new URL(path, "http://test");
    if (engine === "v1") {
      if (url.pathname === "/session") {
        expect(Number(url.searchParams.get("limit"))).toBeGreaterThan(100);
        return Response.json([
          { id: "ses_moved", title: "旧副本", projectId: "proj:stale" },
          { id: "ses_legacy", title: "旧会话", projectId: null },
        ]);
      }
      expect(url.pathname).toBe("/session/ses_legacy/message");
      return url.searchParams.has("before")
        ? Response.json([v1Assistant("v1-1", "ses_legacy", 0.125), v1Assistant("v1-2", "ses_legacy", 0.25)])
        : Response.json([v1Assistant("v1-1", "ses_legacy", 0.125)], { headers: { "X-Next-Cursor": "page-2" } });
    }
    switch (url.pathname) {
      case "/api/session":
        return url.searchParams.has("cursor")
          ? nativePage([{ info: { id: "ses_empty", projectId: "proj:A", title: "空会话" } }])
          : nativePage([{ id: "ses_moved", title: "迁移后的会话", projectId: "proj:A" }], "company:1");
      case "/api/session/ses_empty/message":
        return nativePage([]);
      case "/api/session/ses_moved/message":
        return url.searchParams.has("cursor")
          ? nativePage([v2Event("v2-1", "assistant", 999, 999), v2Event("v2-3", "assistant", undefined, 2)])
          : nativePage([v2Event("v2-1", "assistant", 0.5, 8), v2Event("v2-2", "compaction", 0, 0), v2Event("user", "user", 999, 999)], "older");
      default:
        throw new Error(path);
    }
  };
  const result = await readCompanyCosts(read, async () => ({
    ses_moved: { agentName: "growth" },
    ses_empty: { agentName: "growth" },
    ses_foreign: { agentName: "not-visible" },
  }), new AbortController().signal);

  expect(result.sources).toEqual({ v1: "ready", v2: "ready" });
  expect(result.unreadableSessions).toBe(0);
  expect(result.totals).toEqual({
    cost: 0.875, input: 30, output: 6, reasoning: 4, cacheRead: 8, cacheWrite: 10, events: 5, unpricedEvents: 1,
  });
  expect(result.bySession.map(row => [row.id, row.role, row.projectId, row.usage.cost, row.usage.events])).toEqual([
    ["ses_moved", "growth", "proj:A", 0.5, 3],
    ["ses_legacy", "legacy-native", null, 0.375, 2],
    ["ses_empty", "growth", "proj:A", 0, 0],
  ]);
  expect(result.byRole.map(row => [row.id, row.usage.cost])).toEqual([["growth", 0.5], ["legacy-native", 0.375]]);
  expect(result.byProject.map(row => [row.id, row.usage.cost])).toEqual([["proj:A", 0.5], [null, 0.375]]);
});

test("an unavailable source, mismatched owner or repeated cursor cannot masquerade as a complete total", async () => {
  const read: ReadCostEngine = async (engine, path) => {
    if (engine === "v1") return new Response(null, { status: 503 });
    if (path.startsWith("/api/session?")) return nativePage([
      { id: "ses_healthy", projectId: null }, { id: "ses_bad_owner", projectId: null }, { id: "ses_bad_cursor", projectId: null },
    ]);
    if (path.includes("ses_bad_owner")) return nativePage([v2Event("foreign", "assistant", 999, 10)]);
    if (path.includes("ses_bad_cursor")) return nativePage([{ id: "bad", type: "assistant", cost: 999 }], "stalled");
    return nativePage([{ id: "healthy", type: "assistant", cost: 0, tokens: { input: 0 } }]);
  };
  const report = await readCompanyCosts(read, async () => ({}), new AbortController().signal);
  expect(report.sources).toEqual({ v1: "unavailable", v2: "ready" });
  expect(report.unreadableSessions).toBe(2);
  expect(report.bySession.map(row => row.id)).toEqual(["ses_healthy"]);
  expect(report.totals).toMatchObject({ cost: 0, input: 0, events: 1, unpricedEvents: 0 });
});

test("an intentionally disabled engine is distinct from an unavailable engine", async () => {
  const report = await readCompanyCosts(async (engine) => engine === "v1" ? Response.json([]) : null,
    async () => ({}), new AbortController().signal);
  expect(report.sources).toEqual({ v1: "ready", v2: "disabled" });
  expect(report.totals).toMatchObject({ cost: 0, input: 0, events: 0 });
});

test("v1 prefers stable step-finish usage over an assistant summary that only keeps the last step's tokens", async () => {
  const read: ReadCostEngine = async (engine, path) => {
    if (engine === "v2") return null;
    if (path.startsWith("/session?")) return Response.json([{ id: "ses_legacy", projectId: null }]);
    const assistant = v1Assistant("message", "ses_legacy", 0.375);
    const step1 = { id: "step-1", type: "step-finish", cost: 0.125, tokens: { input: 10, output: 2 } };
    const step2 = { id: "step-2", type: "step-finish", cost: 0.25, tokens: { input: 10, output: 3 } };
    return Response.json([{ ...assistant, parts: [step1, step2, step2] }]);
  };
  const report = await readCompanyCosts(read, async () => ({}), new AbortController().signal);
  expect(report.totals).toMatchObject({ cost: 0.375, input: 20, output: 5, events: 2, unpricedEvents: 0 });
});
