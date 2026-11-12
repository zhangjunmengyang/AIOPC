import { readCompanyCosts, type ReadCostEngine } from "../company-costs.js";
import { readSessionGroupState } from "../session-groups.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

export function registerCompanyCostRoutes(options: {
  routes: Route[];
  config: ServerConfig;
  resolveWorkspaceWithoutBootstrap: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  readEngine: (ctx: RequestContext, workspace: WorkspaceInfo, ...args: Parameters<ReadCostEngine>) => ReturnType<ReadCostEngine>;
}): void {
  const { routes, config, resolveWorkspaceWithoutBootstrap, readEngine } = options;
  addRoute(routes, "GET", "/workspace/:id/company-costs", "client", async ctx => {
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const report = await readCompanyCosts(
      (engine, path) => readEngine(ctx, workspace, engine, path),
      async () => (await readSessionGroupState(config, workspace.id)).state.sessionMeta,
      ctx.request.signal,
    );
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  });
}
