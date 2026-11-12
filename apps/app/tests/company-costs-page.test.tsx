/** @jsxImportSource react */
import { expect, test } from "bun:test";
import type { CompanyCostReport } from "@openwork/types/company-costs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { CompanyCostsPage } from "../src/react-app/domains/aiopc/company-costs-page";

const zero = { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, events: 0, unpricedEvents: 0 };

function renderCosts(report: CompanyCostReport) {
  const companyId = "company-test";
  const queryClient = new QueryClient();
  queryClient.setQueryData(["company-costs", companyId], report);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <CompanyCostsPage companyId={companyId} readCosts={async () => report} onOpenSession={() => {}} />
    </QueryClientProvider>,
  );
}

test("shows native estimates, all three dimensions and explicit zero values", () => {
  const markup = renderCosts({
    totals: zero,
    bySession: [{ id: "ses_free", title: "Zero-cost session", role: "Planner", projectId: "proj:Alpha", usage: zero }],
    byProject: [{ id: "proj:Alpha", usage: zero }],
    byRole: [{ id: "Planner", usage: zero }],
    sources: { v1: "ready", v2: "disabled" },
    unreadableSessions: 0,
  });
  expect(markup).toContain("$0.00");
  expect(markup).toContain("By session");
  expect(markup).toContain("By role");
  expect(markup).toContain("By project");
  expect(markup).toContain("Zero-cost session");
  expect(markup).not.toContain("Partial results");
});

test("shows incomplete and unavailable data without labeling it a complete zero total", () => {
  const partial = renderCosts({
    totals: { ...zero, events: 1, unpricedEvents: 1 }, bySession: [], byProject: [], byRole: [],
    sources: { v1: "unavailable", v2: "ready" }, unreadableSessions: 2,
  });
  expect(partial).toContain("Partial results");
  expect(partial).toContain("No price recorded");
  expect(partial).not.toContain("$0.00");
  const unavailable = renderCosts({
    totals: zero, bySession: [], byProject: [], byRole: [],
    sources: { v1: "unavailable", v2: "disabled" }, unreadableSessions: 0,
  });
  expect(unavailable).toContain("Cost data unavailable");
  expect(unavailable).not.toContain("$0.00");
});
