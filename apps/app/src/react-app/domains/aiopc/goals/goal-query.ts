import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyGoalsClient, CompanyGoalSnapshot, GoalFields } from "./goal-client";

export function useCompanyGoals(client: CompanyGoalsClient | null, workspaceId: string) {
  const cache = useQueryClient();
  const queryKey = ["company-goals", client?.baseUrl ?? "", workspaceId];
  const goals = useQuery({
    queryKey,
    queryFn: () => client!.listCompanyGoals(workspaceId),
    enabled: Boolean(client && workspaceId),
    staleTime: 10_000,
    retry: false,
  });

  const apply = (snapshot: CompanyGoalSnapshot) => {
    cache.setQueryData(queryKey, snapshot);
    // A fresh read reconciles parallel edits returning out of order.
    return cache.invalidateQueries({ queryKey });
  };
  const save = useMutation({
    mutationFn: ({ id, fields }: { id?: string; fields: GoalFields }) => {
      const { projectId, ...changes } = fields;
      return id ? client!.updateCompanyGoal(workspaceId, id, changes)
        : client!.createCompanyGoal(workspaceId, { ...changes, projectId });
    },
    onSuccess: apply,
  });
  const link = useMutation({
    mutationFn: ({ projectId, taskId, goalId }: { projectId: string; taskId: string; goalId: string | null }) =>
      client!.setCompanyGoalTaskLink(workspaceId, projectId, taskId, goalId),
    onSuccess: apply,
  });

  return { goals, save, link };
}
