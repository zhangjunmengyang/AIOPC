import { useId, useState, type FormEvent } from "react";
import { ChevronRight, Flag, Plus, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { GOAL_STATUSES, type CompanyGoal, type CompanyGoalsClient, type CompanyGoalSnapshot, type GoalFields, type GoalStatus } from "./goal-client";
import { goalSelectClass, goalText } from "./goal-copy";
import { CompanyGoalDetail } from "./goal-detail";
import { useCompanyGoals } from "./goal-query";

export type CompanyGoalsPageProps = {
  client: CompanyGoalsClient | null;
  workspaceId: string;
  goalId?: string;
  onOpenGoal?: (goalId: string) => void;
  onOpenTask?: (projectId: string, taskId: string) => void;
};
type Editor = { parentId: string | null; goal?: CompanyGoal };

function GoalEditor({ editor, snapshot, pending, error, onSave, onClose }: {
  editor: Editor;
  snapshot: CompanyGoalSnapshot;
  pending: boolean;
  error: Error | null;
  onSave: (fields: GoalFields) => void;
  onClose: () => void;
}) {
  const current = editor.goal;
  const projectGoal = editor.parentId !== null;
  const titleId = useId();
  const descriptionId = useId();
  const statusId = useId();
  const projectId = useId();
  const parentId = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      title: String(form.get("title") ?? ""),
      description: String(form.get("description") ?? ""),
      status: form.get("status") as GoalStatus,
      projectId: current?.projectId ?? (projectGoal ? String(form.get("project") ?? "") : null),
      parentId: projectGoal ? String(form.get("parent") ?? "") : null,
    });
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent showCloseButton={false} className="overflow-y-auto">
        <DialogHeader><DialogTitle>{goalText(current ? "editGoal" : projectGoal ? "newProjectGoal" : "newCompanyGoal")}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={pending} className="min-w-0 space-y-3">
            <div className="space-y-1.5">
              <label htmlFor={titleId}>{goalText("title")}</label>
              <Input name="title" id={titleId} required maxLength={300} defaultValue={current?.title} />
            </div>
            {projectGoal && !current ? (
              <div className="space-y-1.5">
                <label htmlFor={projectId}>{goalText("project")}</label>
                <select name="project" id={projectId} required className={`${goalSelectClass} w-full`} defaultValue="">
                  <option value="" disabled>{goalText("selectProject")}</option>
                  {snapshot.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </div>
            ) : null}
            {projectGoal ? (
              <div className="space-y-1.5">
                <label htmlFor={parentId}>{goalText("parentGoal")}</label>
                <select name="parent" id={parentId} required className={`${goalSelectClass} w-full`} defaultValue={editor.parentId ?? ""}>
                  {snapshot.items.filter((item) => item.projectId === null).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                </select>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <label htmlFor={statusId}>{goalText("status")}</label>
              <select name="status" id={statusId} className={`${goalSelectClass} w-full`} defaultValue={current?.status ?? "planned"}>
                {GOAL_STATUSES.map((status) => <option key={status} value={status}>{goalText(status)}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor={descriptionId}>{goalText("description")}</label>
              <Textarea name="description" id={descriptionId} maxLength={20_000} defaultValue={current?.description} />
            </div>
          </fieldset>
          {error ? <p role="alert" className="text-sm text-destructive">{error.message || goalText("saveFailed")}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>{goalText("cancel")}</Button>
            <Button type="submit" disabled={pending}>{goalText("save")}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GoalRow({ goal, active, projectName, onOpen }: {
  goal: CompanyGoal; active: boolean; projectName?: string; onOpen: () => void;
}) {
  const Icon = goal.projectId === null ? Target : Flag;
  return (
    <Button type="button" variant={active ? "secondary" : "ghost"} size="sm" aria-current={active ? "page" : undefined}
      className="h-auto min-h-9 w-full min-w-0 justify-start gap-2 whitespace-normal text-left"
      onClick={onOpen}>
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 wrap-anywhere">
        <span className="block">{goal.title}</span>
        {projectName ? <span className="block text-xs font-normal text-muted-foreground">{projectName}</span> : null}
      </span>
      <span className="shrink-0 text-xs font-normal text-muted-foreground">{goalText(goal.status)}</span>
    </Button>
  );
}

function GoalBranch({ goal, children, selectedId, projects, openGoal }: {
  goal: CompanyGoal;
  children: CompanyGoal[];
  selectedId?: string;
  projects: Map<string, string>;
  openGoal: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const childListId = useId();
  const expanded = !collapsed;
  return (
    <li className="py-1">
      <div className="flex items-start gap-1">
        {children.length > 0 ? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={goal.title} aria-expanded={expanded}
            aria-controls={childListId} className="mt-1 shrink-0" onClick={() => setCollapsed(expanded)}>
            <ChevronRight className={`size-3.5 ${expanded ? "rotate-90" : ""}`} aria-hidden />
          </Button>
        ) : <span className="w-7 shrink-0" />}
        <div className="min-w-0 flex-1">
          <GoalRow goal={goal} active={selectedId === goal.id} onOpen={() => openGoal(goal.id)} />
        </div>
      </div>
      {children.length > 0 ? (
        <ul id={childListId} hidden={!expanded} className="ms-7 mt-1 space-y-1 border-s border-border ps-2">
          {children.map((item) => <li key={item.id}><GoalRow goal={item} active={selectedId === item.id}
            projectName={projects.get(item.projectId ?? "") ?? goalText("missingProject")}
            onOpen={() => openGoal(item.id)} /></li>)}
        </ul>
      ) : null}
    </li>
  );
}

export function CompanyGoalsPage(props: CompanyGoalsPageProps) {
  return <CompanyGoalsWorkspace key={`${props.client?.baseUrl ?? ""}/${props.workspaceId}`} {...props} />;
}

function CompanyGoalsWorkspace({ client, workspaceId, goalId, onOpenGoal, onOpenTask }: CompanyGoalsPageProps) {
  const heading = useId();
  const [localGoalId, setLocalGoalId] = useState<string>();
  const [editor, setEditor] = useState<Editor | null>(null);
  const { goals, save, link } = useCompanyGoals(client, workspaceId);
  const snapshot = goals.data;
  const selectedId = goalId ?? (onOpenGoal ? undefined : localGoalId);
  const goal = snapshot?.items.find((item) => item.id === selectedId);
  const projects = new Map(snapshot?.projects.map((project) => [project.id, project.name]));
  const roots = snapshot?.items.filter((item) => item.projectId === null) ?? [];

  function openGoal(id: string) {
    link.reset();
    if (onOpenGoal) onOpenGoal(id);
    else setLocalGoalId(id);
  }

  function openEditor(next: Editor) {
    save.reset();
    setEditor(next);
  }

  return (
    <section aria-labelledby={heading} className="@container/goals h-full min-h-0 min-w-0 overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-5 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h1 id={heading} className="text-xl font-semibold">{goalText("goals")}</h1>
          {snapshot ? <Button type="button" variant="outline" size="sm" onClick={() => openEditor({ parentId: null })}>
            <Plus className="size-4" aria-hidden />{goalText("newCompanyGoal")}
          </Button> : null}
        </header>
        {!client || !workspaceId ? <p className="text-sm text-muted-foreground">{goalText("noCompany")}</p>
          : !snapshot && goals.isPending ? <p role="status" className="text-sm text-muted-foreground">{goalText("loading")}</p>
          : null}
        {goals.error ? <div className="flex flex-wrap items-center gap-2 text-sm">
          <p role="alert" className="text-destructive">{goals.error.message || goalText("loadFailed")}</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => void goals.refetch()}>{goalText("retry")}</Button>
        </div> : null}
        {snapshot ? (
          <div className="grid min-w-0 gap-4 @min-[760px]/goals:grid-cols-[minmax(260px,1fr)_minmax(0,1.5fr)] @min-[760px]/goals:items-start">
            <nav aria-label={goalText("goals")} className="min-w-0 rounded-2xl border border-border bg-card p-2">
              {roots.length ? <ul className="divide-y divide-border/70">
                {roots.map((item) => (
                  <GoalBranch key={item.id} goal={item} children={snapshot.items.filter((entry) => entry.parentId === item.id)}
                    selectedId={selectedId} projects={projects} openGoal={openGoal} />
                ))}
              </ul> : <p className="px-3 py-4 text-sm text-muted-foreground">{goalText("noGoals")}</p>}
            </nav>
            {goal ? (
              <CompanyGoalDetail
                goal={goal}
                snapshot={snapshot}
                onOpenGoal={openGoal}
                onOpenTask={onOpenTask}
                onEdit={() => openEditor({ parentId: goal.parentId, goal })}
                onCreateChild={() => openEditor({ parentId: goal.id })}
                onLink={(projectId, taskId, goalId) => link.mutate({ projectId, taskId, goalId })}
                savingLink={link.isPending}
                linkError={link.error}
              />
            ) : selectedId || roots.length ? (
              <p className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground">
                {goalText(selectedId ? "missingGoal" : "selectGoal")}
              </p>
            ) : null}
          </div>
        ) : null}
        {snapshot && editor ? (
          <GoalEditor editor={editor} snapshot={snapshot} pending={save.isPending} error={save.error}
            onClose={() => setEditor(null)}
            onSave={(fields) => save.mutate({ id: editor.goal?.id, fields }, { onSuccess: () => setEditor(null) })} />
        ) : null}
      </div>
    </section>
  );
}
