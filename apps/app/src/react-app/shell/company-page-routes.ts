export const COMPANY_PAGES = ["org-chart", "goals", "costs"] as const;

export type CompanyPage = typeof COMPANY_PAGES[number];

export function companyPagePattern(page: CompanyPage) {
  return `/workspace/:workspaceId/${page}${page === "goals" ? "/:goalId?" : ""}`;
}

export function companyPageRoute(workspaceId: string, page: CompanyPage, goalId?: string) {
  const detail = page === "goals" && goalId ? `/${encodeURIComponent(goalId)}` : "";
  return `/workspace/${encodeURIComponent(workspaceId)}/${page}${detail}`;
}
