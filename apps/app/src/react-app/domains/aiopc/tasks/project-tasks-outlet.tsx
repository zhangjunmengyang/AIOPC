import { useLocation, useNavigate } from "react-router";

import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { companyPageRoute } from "@/react-app/shell/company-page-routes";
import { workspaceProjectsRoute } from "@/react-app/shell/workspace-routes";

import { TaskGoalField } from "../goals/task-goal-field";
import { projectTaskHref, readProjectTaskId } from "../project-work-navigation";
import { TaskBoardPage, type TaskBoardPageProps } from "./task-board-page";

type ProjectTasksOutletProps = Omit<TaskBoardPageProps, "taskId" | "onTaskIdChange" | "renderTaskGoal"> & {
  workspaceId: string;
  projectId: string;
  endpoint: ResolvedWorkspaceEndpoint | null;
};

export function ProjectTasksOutlet({ workspaceId, projectId, endpoint, ...board }: ProjectTasksOutletProps) {
  const { search } = useLocation();
  const navigate = useNavigate();
  const projectHref = workspaceProjectsRoute(workspaceId, board.projectName);

  return <TaskBoardPage
    {...board}
    taskId={readProjectTaskId(search)}
    onTaskIdChange={(taskId) => navigate(projectTaskHref(projectHref, taskId), { replace: taskId === null })}
    renderTaskGoal={endpoint ? (task) => (
      <TaskGoalField
        key={JSON.stringify([endpoint.client.baseUrl, endpoint.workspaceId, projectId, task.id])}
        client={endpoint.client}
        workspaceId={endpoint.workspaceId}
        projectId={projectId}
        taskId={task.id}
        goalHref={(goalId) => companyPageRoute(workspaceId, "goals", goalId)}
      />
    ) : undefined}
  />;
}
