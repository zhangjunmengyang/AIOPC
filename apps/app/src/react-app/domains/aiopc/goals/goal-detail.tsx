import { useState } from "react";
import { Link } from "react-router";
import { ArrowUpRight, ListChecks, Plus } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useProjectTasks } from "../tasks/task-client";
import type { CompanyGoal, CompanyGoalProject, CompanyGoalSnapshot } from "./goal-client";
import { goalSelectClass, goalText } from "./goal-copy";

export type TaskHref = (project: CompanyGoalProject, taskId: string) => string;
type ChangeLink = (projectId: string, taskId: string, goalId: string | null) => void;

function LinkedProjectTasks({ goal, project, links, taskHref, onLink, saving, error }: {
  goal: CompanyGoal;
  project: CompanyGoalProject;
  links: CompanyGoalSnapshot["links"];
  taskHref?: TaskHref;
  onLink: ChangeLink;
  saving: boolean;
  error: Error | null;
}) {
  const [taskId, setTaskId] = useState("");
  const { connection, tasks } = useProjectTasks(project.directory);
  const ready = connection?.status === "ready";
  const items = tasks.data?.items ?? [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const projectLinks = links.filter((link) => link.projectId === project.id);
  const associated = projectLinks.filter((link) => link.goalId === goal.id);
  const assigned = new Set(projectLinks.map((link) => link.taskId));
  const available = items.filter((item) => !assigned.has(item.id));
  const selectedTask = available.find((item) => item.id === taskId);
  const loadError = tasks.error || (connection?.status === "failed" || connection?.status === "unavailable" ? connection.error : null);

  return (
    <section className="space-y-3 border-t border-border pt-4">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <ListChecks className="size-4 text-muted-foreground" aria-hidden />{goalText("tasks")}
      </h3>
      {loadError ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <p role="alert" className="text-destructive">{goalText("loadTasksFailed")}</p>
          {ready ? <Button type="button" variant="ghost" size="sm" onClick={() => void tasks.refetch()}>{goalText("retry")}</Button> : null}
        </div>
      ) : tasks.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">{goalText("loadingTasks")}</p>
      ) : null}
      {associated.length ? (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {associated.map((link) => {
            const item = byId.get(link.taskId);
            const title = item?.title ?? (tasks.isSuccess ? `${goalText("missingTask")} · ${link.taskId}` : link.taskId);
            return (
              <li key={link.taskId} className="flex items-start gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  {taskHref && (!tasks.isSuccess || item) ? (
                    <Link to={taskHref(project, link.taskId)} className={cn(buttonVariants({ variant: "ghost", size: "sm" }),
                      "h-auto min-h-7 w-full justify-start whitespace-normal px-0 text-left")}>
                      <span className="wrap-anywhere">{title}</span><ArrowUpRight className="size-3 text-muted-foreground" aria-hidden />
                    </Link>
                  ) : item ? (
                    <details className="text-sm">
                      <summary className="cursor-pointer py-1 font-medium wrap-anywhere">{title}</summary>
                      {item.description ? <p className="mt-1 whitespace-pre-wrap wrap-anywhere text-muted-foreground">{item.description}</p> : null}
                    </details>
                  ) : <p className="py-1 text-sm wrap-anywhere text-muted-foreground">{title}</p>}
                  {item ? <p className="text-xs text-muted-foreground">{goalText(item.status)}</p> : null}
                </div>
                <Button type="button" variant="ghost" size="sm" disabled={saving} aria-label={`${goalText("unlinkTask")} ${title}`}
                  onClick={() => onLink(project.id, link.taskId, null)}>{goalText("unlinkTask")}</Button>
              </li>
            );
          })}
        </ul>
      ) : <p className="text-sm text-muted-foreground">{goalText("noTasks")}</p>}
      {available.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <select className={goalSelectClass} aria-label={goalText("chooseTask")} value={selectedTask?.id ?? ""}
            disabled={saving} onChange={(event) => setTaskId(event.target.value)}>
            <option value="">{goalText("chooseTask")}</option>
            {available.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
          <Button type="button" size="sm" variant="outline" disabled={saving || !selectedTask}
            onClick={() => selectedTask && onLink(project.id, selectedTask.id, goal.id)}>{goalText("linkTask")}</Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error.message || goalText("saveFailed")}</p> : null}
    </section>
  );
}

export function CompanyGoalDetail({ goal, snapshot, onOpenGoal, taskHref, onEdit, onCreateChild, onLink, savingLink, linkError }: {
  goal: CompanyGoal;
  snapshot: CompanyGoalSnapshot;
  onOpenGoal: (id: string) => void;
  taskHref?: TaskHref;
  onEdit: () => void;
  onCreateChild: () => void;
  onLink: ChangeLink;
  savingLink: boolean;
  linkError: Error | null;
}) {
  const parent = snapshot.items.find((item) => item.id === goal.parentId);
  const project = snapshot.projects.find((item) => item.id === goal.projectId);
  const children = snapshot.items.filter((item) => item.parentId === goal.id);
  return (
    <article className="min-w-0 space-y-5 rounded-2xl border border-border bg-card p-4 sm:p-6">
      <div className="space-y-2">
        {parent ? (
          <Button type="button" size="sm" variant="ghost" className="h-auto min-h-6 max-w-full justify-start whitespace-normal px-0 text-left text-muted-foreground"
            onClick={() => onOpenGoal(parent.id)}>{parent.title}</Button>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1.5">
            <p className="text-xs text-muted-foreground">{goal.projectId === null ? goalText("companyGoal") : project?.name ?? goalText("missingProject")}</p>
            <h2 className="text-lg font-semibold wrap-anywhere">{goal.title}</h2>
            <p className="text-sm text-muted-foreground">{goalText(goal.status)}</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>{goalText("editGoal")}</Button>
        </div>
      </div>
      {goal.description ? <p className="whitespace-pre-wrap text-sm wrap-anywhere">{goal.description}</p> : null}
      {goal.projectId === null ? (
        <section className="space-y-3 border-t border-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{goalText("projectGoal")}</h3>
            <Button type="button" variant="outline" size="sm" disabled={snapshot.projects.length === 0} onClick={onCreateChild}>
              <Plus className="size-3.5" aria-hidden />{goalText("newProjectGoal")}
            </Button>
          </div>
          {snapshot.projects.length === 0 ? <p className="text-sm text-muted-foreground">{goalText("noProjects")}</p> : null}
          {children.length ? (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {children.map((item) => (
                <li key={item.id} className="px-3 py-1">
                  <Button type="button" variant="ghost" size="sm" className="h-auto min-h-8 w-full justify-start whitespace-normal px-0 text-left"
                    onClick={() => onOpenGoal(item.id)}>{item.title}</Button>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">{goalText("noProjectGoals")}</p>}
        </section>
      ) : project ? (
        <LinkedProjectTasks key={goal.id} goal={goal} project={project} links={snapshot.links} taskHref={taskHref}
          onLink={onLink} saving={savingLink} error={linkError} />
      ) : null}
    </article>
  );
}
