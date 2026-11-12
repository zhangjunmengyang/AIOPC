import { useMemo } from "react";
import { useNavigate } from "react-router";

import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { t } from "@/i18n";
import { companyPageRoute, type CompanyPage } from "@/react-app/shell/company-page-routes";

import { CompanyCostsPage } from "./company-costs-page";
import { CompanyOrgPage } from "./company-org-page";
import type { TaskHref } from "./goals/goal-detail";
import { CompanyGoalsPage } from "./goals/goals-page";

export function CompanyPageOutlet({
  page, goalId, workspaceId, endpoint, loading, onOpenSession, taskHref,
}: {
  page: CompanyPage;
  goalId?: string;
  workspaceId: string;
  endpoint: ResolvedWorkspaceEndpoint | null;
  loading: boolean;
  onOpenSession: (sessionId: string) => void;
  taskHref?: TaskHref;
}) {
  const navigate = useNavigate();
  const company = useMemo(() => {
    if (!endpoint) return null;
    const { client, workspaceId } = endpoint;
    return {
      client,
      id: workspaceId,
      loadOrgChart: () => client.readCompanyOrg(workspaceId),
      updateReportingLine: (roleId: string, reportsTo: string | null) => client.updateCompanyReportingLine(workspaceId, roleId, reportsTo),
      readCosts: (signal: AbortSignal) => client.readCompanyCosts(workspaceId, signal),
    };
  }, [endpoint]);

  if (!company) {
    return <p role="status" className="p-6 text-sm text-muted-foreground">
      {t(loading ? "aiopc.loading" : "aiopc.company.disconnected")}
    </p>;
  }
  const companyScope = JSON.stringify([company.client.baseUrl, company.id]);
  if (page === "org-chart") {
    return <CompanyOrgPage key={companyScope} loadOrgChart={company.loadOrgChart} updateReportingLine={company.updateReportingLine} />;
  }
  if (page === "costs") {
    return <CompanyCostsPage key={companyScope} companyId={companyScope} readCosts={company.readCosts} onOpenSession={onOpenSession} />;
  }
  return <CompanyGoalsPage key={companyScope} client={company.client} workspaceId={company.id} goalId={goalId} taskHref={taskHref}
    onOpenGoal={(id) => navigate(companyPageRoute(workspaceId, "goals", id))} />;
}
