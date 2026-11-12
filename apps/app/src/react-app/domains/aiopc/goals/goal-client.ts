export const GOAL_STATUSES = ["planned", "active", "achieved", "cancelled"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type GoalFields = {
  title: string;
  description?: string;
  status?: GoalStatus;
  projectId: string | null;
  parentId: string | null;
};

export type CompanyGoal = Required<GoalFields> & { id: string };
export type CompanyGoalProject = { id: string; name: string; directory: string };
export type GoalTaskLink = { projectId: string; taskId: string; goalId: string };
export type CompanyGoalSnapshot = { items: CompanyGoal[]; projects: CompanyGoalProject[]; links: GoalTaskLink[] };

type RequestGoalsJson = <T>(path: string, options?: { method?: "POST" | "PATCH"; body?: unknown }) => Promise<T>;

export type CompanyGoalsClient = {
  baseUrl?: string;
  listCompanyGoals: (workspaceId: string) => Promise<CompanyGoalSnapshot>;
  createCompanyGoal: (workspaceId: string, fields: GoalFields) => Promise<CompanyGoalSnapshot>;
  updateCompanyGoal: (workspaceId: string, goalId: string, fields: Partial<Omit<GoalFields, "projectId">>) => Promise<CompanyGoalSnapshot>;
  setCompanyGoalTaskLink: (workspaceId: string, projectId: string, taskId: string, goalId: string | null) => Promise<CompanyGoalSnapshot>;
};

export function createCompanyGoalsClient(request: RequestGoalsJson): Omit<CompanyGoalsClient, "baseUrl"> {
  const goals = (workspaceId: string) => `/workspace/${encodeURIComponent(workspaceId)}/goals`;
  return {
    listCompanyGoals: (workspaceId) => request(goals(workspaceId)),
    createCompanyGoal: (workspaceId, fields) => request(goals(workspaceId), { method: "POST", body: fields }),
    updateCompanyGoal: (workspaceId, goalId, fields) =>
      request(`${goals(workspaceId)}/${encodeURIComponent(goalId)}`, { method: "PATCH", body: fields }),
    setCompanyGoalTaskLink: (workspaceId, projectId, taskId, goalId) =>
      request(`${goals(workspaceId)}/task-links/${encodeURIComponent(projectId)}/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: { goalId },
      }),
  };
}
