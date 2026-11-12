import { useQueries, useQuery } from "@tanstack/react-query";

import { unwrap } from "@/app/lib/opencode";
import { isOpencodeV2Client } from "@/app/lib/opencode-v2-adapter";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { Client } from "@/app/types";
import { aiopcRequest, useAiopc } from "./aiopc-client";
import type { TeamPublishRecord, TeamTask } from "./team-data";

const REFRESH_MS = 15_000;

export function useTeamData(endpoint: ResolvedWorkspaceEndpoint | null, client: Client | null, companyRoot: string) {
  const { connection, ready, request } = useAiopc(companyRoot);
  const workspaceKey = [endpoint?.baseUrl, endpoint?.workspaceId];
  const native = client && isOpencodeV2Client(client) ? client : null;
  const engineKey = [native ? "v2" : "v1", ...workspaceKey];

  const roles = useQuery({
    queryKey: ["aiopc", "company-roles", ...workspaceKey],
    enabled: Boolean(endpoint),
    queryFn: () => endpoint!.client.listCompanyRoles(endpoint!.workspaceId),
    refetchInterval: REFRESH_MS,
  });
  const groups = useQuery({
    queryKey: ["aiopc", "team-session-groups", ...workspaceKey],
    enabled: Boolean(endpoint),
    queryFn: () => endpoint!.client.getSessionGroups(endpoint!.workspaceId),
    refetchInterval: REFRESH_MS,
  });
  const active = useQuery({
    queryKey: ["aiopc", "team-active", ...engineKey],
    enabled: Boolean(client),
    queryFn: async ({ signal }) => {
      const statuses = unwrap(await client!.session.status({}, { signal }));
      return new Set(Object.entries(statuses).filter(([, state]) => state.type !== "idle").map(([id]) => id));
    },
    refetchInterval: 5_000,
  });
  const waiting = useQuery({
    queryKey: ["aiopc", "team-waiting", ...engineKey],
    enabled: Boolean(client),
    queryFn: async ({ signal }) => {
      const [permissions, questions] = await Promise.all([
        native ? native.listWorkspacePermissions({ signal }) : client!.permission.list({}, { signal }),
        client!.question.list({}, { signal }),
      ]);
      return new Set([...unwrap(permissions), ...unwrap(questions)].map((item) => item.sessionID));
    },
    refetchInterval: 5_000,
  });

  const projects = useQuery({
    queryKey: ["aiopc", companyRoot, "team-projects"],
    enabled: ready,
    queryFn: () => request<{ projects: Array<{ id: string; name: string; path: string }> }>("GET", "/api/projects"),
    refetchInterval: REFRESH_MS,
  });
  const scopes = [
    ...(ready ? [{ id: "", name: "", path: companyRoot }] : []),
    ...(projects.data?.projects ?? []),
  ];
  const scopeReads = useQueries({
    queries: scopes.map((scope) => ({
      queryKey: ["aiopc", companyRoot, "team-outputs", scope.path],
      enabled: ready,
      refetchInterval: REFRESH_MS,
      queryFn: async () => {
        const [tasks, history] = await Promise.allSettled([
          scope.id
            ? aiopcRequest<{ items: TeamTask[]; issues?: unknown[] }>(connection!, scope.path, "GET", "/api/tasks")
            : Promise.resolve({ items: [], issues: [] }),
          aiopcRequest<{ items: TeamPublishRecord[] }>(connection!, scope.path, "GET", "/api/history"),
        ]);
        return {
          id: scope.id, name: scope.name, directory: scope.path,
          tasks: tasks.status === "fulfilled" ? tasks.value.items : [],
          history: history.status === "fulfilled" ? history.value.items : [],
          partial: tasks.status === "rejected" || Boolean(tasks.value.issues?.length) || history.status === "rejected",
        };
      },
    })),
  });

  return {
    roles,
    groups,
    active,
    waiting,
    projects: (projects.data?.projects ?? []).map((project) => ({
      id: project.id, name: project.name, directory: project.path,
      skills: roles.data?.projectSkills[project.id] ?? [],
    })),
    outputs: scopeReads.flatMap((scope) => scope.data ? [scope.data] : []),
    outputsLoading: (!connection || ready) && (projects.isPending || scopeReads.some((scope) => scope.isPending)),
    outputsIncomplete: Boolean(connection && !ready) || projects.isError || scopeReads.some((scope) => scope.data?.partial || scope.isError),
  };
}
