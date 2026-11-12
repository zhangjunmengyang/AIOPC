import { Link } from "react-router";

import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { workspaceProjectsRoute } from "@/react-app/shell/workspace-routes";
import { projectNameFromGroupId } from "./company-project";

const sections = ["overview", "tasks", "routines"] as const;
export type ProjectWorkSection = (typeof sections)[number];

const labels = {
  zh: { navigation: "项目页面", overview: "项目总览", tasks: "任务看板", routines: "例行任务" },
  en: { navigation: "Project pages", overview: "Overview", tasks: "Task board", routines: "Routines" },
};

function copy() {
  return currentLocale() === "zh" ? labels.zh : labels.en;
}

export function readProjectWorkSection(search: string): ProjectWorkSection {
  const view = new URLSearchParams(search).get("view");
  return view === "tasks" || view === "routines" ? view : "overview";
}

export function projectWorkHref(projectHref: string, section: ProjectWorkSection): string {
  return section === "overview" ? projectHref : `${projectHref}?view=${section}`;
}

export function readProjectTaskId(search: string): string | undefined {
  const params = new URLSearchParams(search);
  const taskId = params.get("task");
  return params.get("view") === "tasks" && isTaskId(taskId) ? taskId : undefined;
}

function isTaskId(taskId: string | null | undefined): taskId is string {
  return typeof taskId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(taskId);
}

export function projectTaskHref(projectHref: string, taskId?: string | null): string {
  const board = projectWorkHref(projectHref, "tasks");
  return taskId ? `${board}&task=${encodeURIComponent(taskId)}` : board;
}

export function sessionProjectTaskHref(workspaceId: string, meta?: { projectId?: string | null; taskId?: string | null }) {
  const projectName = projectNameFromGroupId(meta?.projectId);
  return workspaceId && projectName && isTaskId(meta?.taskId)
    ? projectTaskHref(workspaceProjectsRoute(workspaceId, projectName), meta.taskId) : undefined;
}

export function ProjectWorkNavigation({ projectHref, current }: { projectHref: string; current: ProjectWorkSection }) {
  const text = copy();
  return (
    <nav aria-label={text.navigation} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 sm:px-6">
      {sections.map((section) => (
        <Link key={section} to={projectWorkHref(projectHref, section)}
          aria-current={current === section ? "page" : undefined}
          className={cn("border-b-2 px-1 py-2.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2",
            current === section ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
          {text[section]}
        </Link>
      ))}
    </nav>
  );
}
