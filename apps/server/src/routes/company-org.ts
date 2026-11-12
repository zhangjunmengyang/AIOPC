import { listCompanyOrgRoles, updateCompanyReportingLine } from "../company-org.js";
import { ApiError } from "../errors.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

interface RegisterCompanyOrgRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspaceWithoutBootstrap: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

export function registerCompanyOrgRoutes({
  routes, config, jsonResponse, readJsonBody, ensureWritable, requireClientScope, resolveWorkspaceWithoutBootstrap,
}: RegisterCompanyOrgRoutesOptions): void {
  addRoute(routes, "GET", "/workspace/:id/company/org-chart", "client", async (ctx) => {
    const company = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    return jsonResponse({ roles: await listCompanyOrgRoles(company.path) });
  });

  addRoute(routes, "PATCH", "/workspace/:id/company/org-chart/:roleId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const company = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const { reportsTo } = await readJsonBody(ctx.request);
    if (reportsTo !== null && (typeof reportsTo !== "string" || !reportsTo.trim())) {
      throw new ApiError(400, "invalid_payload", "reportsTo 必须是角色 ID 或 null");
    }
    const roles = await updateCompanyReportingLine(company.path, ctx.params.roleId, reportsTo);
    return jsonResponse({ roles });
  });
}
