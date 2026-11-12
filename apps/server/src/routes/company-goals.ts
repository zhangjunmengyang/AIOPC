import { readCompanyGoals, saveCompanyGoal, setCompanyGoalTaskLink } from "../company-goals.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type RegisterCompanyGoalRoutesOptions = {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (body: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspaceWithoutBootstrap: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
};

export function registerCompanyGoalRoutes({
  routes, config, jsonResponse, readJsonBody, ensureWritable, requireClientScope, resolveWorkspaceWithoutBootstrap,
}: RegisterCompanyGoalRoutesOptions): void {
  const base = "/workspace/:id/goals";
  const company = (ctx: RequestContext) => resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
  async function writableCompany(ctx: RequestContext) {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    return company(ctx);
  }

  addRoute(routes, "GET", base, "client", async (ctx) => jsonResponse(await readCompanyGoals(config, await company(ctx))));
  addRoute(routes, "POST", base, "client", async (ctx) => {
    const workspace = await writableCompany(ctx);
    return jsonResponse(await saveCompanyGoal(config, workspace, await readJsonBody(ctx.request)), 201);
  });
  addRoute(routes, "PATCH", `${base}/:goalId`, "client", async (ctx) => {
    const workspace = await writableCompany(ctx);
    return jsonResponse(await saveCompanyGoal(config, workspace, await readJsonBody(ctx.request), ctx.params.goalId));
  });
  addRoute(routes, "PATCH", `${base}/task-links/:projectId/:taskId`, "client", async (ctx) => {
    const workspace = await writableCompany(ctx);
    const { goalId } = await readJsonBody(ctx.request);
    return jsonResponse(await setCompanyGoalTaskLink(config, workspace, ctx.params.projectId, ctx.params.taskId, goalId));
  });
}
