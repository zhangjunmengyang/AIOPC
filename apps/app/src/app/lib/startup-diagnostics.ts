import { recordInspectorEvent } from "./app-inspector";

/** Startup observations stay on this device. */
export function markStartupStep(step: string) {
  try { recordInspectorEvent("startup.step", { step }); } catch {}
}

export function failStartup(step: string, reason: string) {
  try { recordInspectorEvent("startup.failed", { step, reason }); } catch {}
}
