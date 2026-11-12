import { recordInspectorEvent } from "./app-inspector";

export type AnalyticsProperties = Record<string, string | number | boolean | null>;

/** Local diagnostics only. */
export function captureAnalyticsEvent(event: string, properties: AnalyticsProperties = {}) {
  try { recordInspectorEvent(`analytics.${event}`, properties); } catch { /* No renderer in headless contexts. */ }
}

const taskRunStarts = new Map<string, number>();

export function markTaskRunStart(sessionId: string) {
  if (sessionId.trim()) taskRunStarts.set(sessionId, Date.now());
}

export function takeTaskRunStart(sessionId: string): number | null {
  const startedAt = taskRunStarts.get(sessionId);
  if (startedAt === undefined) return null;
  taskRunStarts.delete(sessionId);
  return startedAt;
}



export function isAnalyticsEnabled(): boolean { return false; }
