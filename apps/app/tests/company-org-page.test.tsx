/** @jsxImportSource react */
import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

const { setLocale, currentLocale } = await import("../src/i18n");
const { CompanyOrgPage, buildCompanyOrgChart, reportingLineOptions } = await import("../src/react-app/domains/aiopc/company-org-page");
const roles = [
  { id: "lead", name: "负责人", reportsTo: null },
  { id: "design", name: "设计", description: "设计方向", reportsTo: "lead" },
  { id: "writer", name: "写作", reportsTo: "design" },
  { id: "independent", name: "独立角色", reportsTo: null },
];

test("shows the chart tree and opens role reporting settings", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const previousLocale = currentLocale();
  setLocale("zh");
  const loadOrgChart = mock(async () => ({ roles }));
  const updateReportingLine = mock(async () => ({ roles }));
  try {
    await act(async () => root.render(<CompanyOrgPage loadOrgChart={loadOrgChart} updateReportingLine={updateReportingLine} />));
    expect(loadOrgChart).toHaveBeenCalledTimes(1);
    const lead = host.querySelector('[data-org-role="lead"]');
    expect(lead?.querySelector('[data-org-role="design"] [data-org-role="writer"]')).not.toBeNull();
    expect(lead?.querySelector('[data-org-role="independent"]')).toBeNull();
    const design = host.querySelector<HTMLButtonElement>('button[aria-label="编辑设计的汇报关系"]');
    expect(design).not.toBeNull();
    await act(async () => design?.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("设计方向");
    expect(dialog?.textContent).toContain("负责人");
    expect(dialog?.textContent).toContain("写作");
    expect(dialog?.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    setLocale(previousLocale);
  }
});

test("legacy broken reporting links remain visible and cannot become new managers", () => {
  const damaged = [
    ...roles,
    { id: "missing", name: "外部上级", reportsTo: "not-in-company" },
    { id: "first", name: "一", reportsTo: "second" },
    { id: "second", name: "二", reportsTo: "first" },
  ];
  const chart = buildCompanyOrgChart(damaged);
  const count = (nodes: typeof chart): number => nodes.reduce((sum, node) => sum + 1 + count(node.children), 0);
  expect(count(chart)).toBe(damaged.length);
  expect(chart.find((node) => node.role.id === "missing")?.role.reportsTo).toBe("not-in-company");
  expect(reportingLineOptions(damaged, "design").map((role) => role.id)).toEqual(["lead", "independent", "missing"]);
});
