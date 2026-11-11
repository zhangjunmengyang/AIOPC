import { t } from "@/i18n";

import type { BrowserPanelTab } from "./panel-tab-store";

const OPERATION_KEYS = new Set([
  "observe", "site_tools", "site_tool", "navigate", "click", "fill", "key", "scroll", "website_blocked", "browser_disabled",
  "stale_observation", "stale_tool", "user_denied", "needs_attention", "sign_in_required", "payment_required", "timeout", "result_withheld",
]);

/** What the agent is doing on the page, in the current language; undefined for unknown operations. */
export const browserOperationLabels: Record<string, string> = new Proxy({} as Record<string, string>, {
  get: (_target, key) => (typeof key === "string" && OPERATION_KEYS.has(key) ? t(`aiopc.browser.op.${key}`) : undefined),
});

/** The page needs attention or a human handoff. */
export function browserNeedsPerson(tab: BrowserPanelTab | null | undefined): boolean {
  return tab?.browserTask?.status === "needs_attention";
}

/** One short state line for the browser's header button. */
export function browserStatusLabel(tab: BrowserPanelTab | null | undefined): string {
  if (!tab) return t("aiopc.browser.state.no_page");
  if (browserNeedsPerson(tab)) return t("aiopc.browser.state.needs_you");
  const task = tab.browserTask;
  if (task?.status === "paused") return t("aiopc.browser.state.you_control");
  if (task?.status === "running") return browserOperationLabels[task.operation ?? ""] ?? t("aiopc.browser.state.working");
  if (tab.status === "suspended") return t("aiopc.browser.state.suspended");
  if (tab.status === "loading" || tab.status === "restoring") return t("aiopc.browser.state.loading");
  if (tab.loadError) return t("aiopc.browser.state.load_failed");
  return t("aiopc.browser.state.ready");
}
