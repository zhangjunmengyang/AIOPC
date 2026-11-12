import { useId, useState, type DragEvent } from "react";
import { Circle, CircleAlert, CircleCheck, CircleDashed, CircleDot, MessageSquare, Plus, UserRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { AiopcUnavailable } from "../aiopc-status";
import { TASK_STATUSES, taskDeliverableAbsolutePath, taskDeliverableLabel, useProjectTasks, type ProjectTask, type TaskDeliverable, type TaskFields, type TaskRole, type TaskSession, type TaskStatus } from "./task-client";
import { taskError, taskText } from "./task-copy";
import { TaskDeliverablePreview } from "./task-deliverable-preview";
import { taskAssigneeLabel, TaskDeliverableAction, TaskDetail, type TaskDetailProps } from "./task-detail";
import { TaskForm } from "./task-form";

export type TaskBoardPageProps = Pick<TaskDetailProps, "onOpenSession" | "onStartSession" | "onBindSession" | "onUnbindSession"> & {
  projectPath: string;
  projectName: string;
  roles: readonly TaskRole[];
  sessions: readonly TaskSession[];
  onOpenDeliverable?: (deliverable: TaskDeliverable) => void | Promise<void>;
};

type Editor = { mode: "create" } | { mode: "detail" | "edit"; id: string };

const STATUS_ICONS = {
  todo: { Icon: CircleDashed, className: "text-muted-foreground" },
  in_progress: { Icon: CircleDot, className: "text-blue-11" },
  in_review: { Icon: Circle, className: "text-warning" },
  done: { Icon: CircleCheck, className: "text-green-11" },
  blocked: { Icon: CircleAlert, className: "text-destructive" },
};

export function TaskBoardPage(props: TaskBoardPageProps) {
  return <ProjectTaskBoard key={props.projectPath} {...props} />;
}

function ProjectTaskBoard(props: TaskBoardPageProps) {
  const { connection, tasks, saveTask } = useProjectTasks(props.projectPath);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preview, setPreview] = useState<TaskDeliverable | null>(null);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | null>(null);
  const [dragging, setDragging] = useState<ProjectTask | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const headingId = useId();
  const items = tasks.data?.items ?? [];
  const byStatus = Map.groupBy(items, (task) => task.status);
  const visibleStatus = statusFilter ?? TASK_STATUSES.find((status) => byStatus.has(status)) ?? "todo";
  const firstSessionByTask = new Map<string, TaskSession>();
  for (const session of props.sessions) {
    if (session.taskId && !firstSessionByTask.has(session.taskId)) firstSessionByTask.set(session.taskId, session);
  }
  const selectedTask = editor && editor.mode !== "create" ? items.find((task) => task.id === editor.id) : undefined;

  function showTask(id: string) {
    setDialogError("");
    setEditor({ mode: "detail", id });
  }

  function openSession(id: string) {
    props.onOpenSession(id);
    setEditor(null);
  }

  async function openDeliverable(deliverable: TaskDeliverable) {
    const report = editor ? setDialogError : setError;
    report("");
    if (!taskDeliverableAbsolutePath(props.projectPath, deliverable)) {
      report(taskText("previewFailed"));
      return;
    }
    if (!props.onOpenDeliverable) {
      setPreview(deliverable);
      return;
    }
    try {
      await props.onOpenDeliverable(deliverable);
    } catch (error) {
      report(taskError(error, "previewFailed"));
    }
  }

  async function save(fields: Partial<TaskFields>, expectedUpdatedAt?: string) {
    const task = await saveTask.mutateAsync({ id: selectedTask?.id, fields, expectedUpdatedAt });
    setStatusFilter(task.status);
    showTask(task.id);
  }

  function finishDrag() {
    setDragging(null);
    setOver(null);
  }

  function onDragOver(event: DragEvent, status: TaskStatus) {
    if (!dragging || dragging.status === status) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setOver(status);
  }

  async function drop(event: DragEvent, status: TaskStatus) {
    event.preventDefault();
    finishDrag();
    if (!dragging || dragging.status === status || saveTask.isPending) return;
    setError("");
    try {
      const task = await saveTask.mutateAsync({ id: dragging.id, fields: { status }, expectedUpdatedAt: dragging.updatedAt });
      setStatusFilter(task.status);
    } catch (error) {
      setError(taskError(error, "saveFailed"));
    }
  }

  if (connection?.status !== "ready") return <AiopcUnavailable connection={connection} title={taskText("tasks")} />;

  return (
    <section className="@container/tasks h-full min-h-0 min-w-0 overflow-y-auto" aria-labelledby={headingId}>
      <div className="mx-auto max-w-[104rem] space-y-5 px-4 py-6 sm:px-6 sm:py-7">
        <header className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            <p className="mb-0.5 text-xs text-muted-foreground wrap-anywhere">{props.projectName}</p>
            <h1 id={headingId} className="text-xl font-semibold tracking-tight">{taskText("tasks")}</h1>
          </div>
          <Button size="sm" onClick={() => { setDialogError(""); setEditor({ mode: "create" }); }}>
            <Plus className="size-4" aria-hidden />{taskText("newTask")}
          </Button>
        </header>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {tasks.isPending ? <p role="status" className="text-sm text-muted-foreground">{taskText("loading")}</p> : null}
        {tasks.isError ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
            <p>{taskError(tasks.error, "loadFailed")}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void tasks.refetch()}>{taskText("retry")}</Button>
          </div>
        ) : null}
        {tasks.data?.issues?.length ? (
          <details className="space-y-2 rounded-lg border border-border p-3 text-sm">
            <summary className="cursor-pointer text-warning">{taskText("unreadableFiles")} ({tasks.data.issues.length})</summary>
            <ul className="space-y-1 text-muted-foreground">
              {tasks.data.issues.map((issue) => <li key={issue.file} className="wrap-anywhere">{issue.file} · {issue.message}</li>)}
            </ul>
          </details>
        ) : null}
        {tasks.data ? (
          <>
            <div role="group" aria-label={taskText("filterByStatus")} className="flex flex-wrap gap-1.5 @min-[860px]/tasks:hidden">
              {TASK_STATUSES.map((status) => (
                <Button key={status} type="button" size="sm" variant={visibleStatus === status ? "secondary" : "outline"}
                  aria-pressed={visibleStatus === status} className="min-h-10 rounded-lg" onClick={() => setStatusFilter(status)}>
                  {taskText(status)}<span className="text-muted-foreground tabular-nums">{byStatus.get(status)?.length ?? 0}</span>
                </Button>
              ))}
            </div>
            <div className="grid items-start gap-3 @min-[860px]/tasks:grid-cols-5">
              {TASK_STATUSES.map((status) => {
                const columnTasks = byStatus.get(status) ?? [];
                const { Icon, className } = STATUS_ICONS[status];
                return (
                  <section key={status} data-task-status={status} aria-labelledby={`${headingId}-${status}`}
                    onDragOver={(event) => onDragOver(event, status)} onDragLeave={(event) => {
                      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(null);
                    }} onDrop={(event) => void drop(event, status)}
                    className={cn("min-w-0 rounded-xl border border-border/65 bg-muted/35 p-2 @min-[860px]/tasks:block", visibleStatus !== status && "hidden",
                      over === status && "border-ring bg-muted/70 ring-1 ring-ring/40")}>
                    <h2 id={`${headingId}-${status}`} className="flex items-center gap-2 px-1.5 py-1.5 text-sm font-medium">
                      <Icon aria-hidden className={cn("size-4 shrink-0", className)} />
                      <span>{taskText(status)}</span>
                      <span className="ms-auto text-xs text-muted-foreground tabular-nums">{columnTasks.length}</span>
                    </h2>
                    {columnTasks.length ? (
                      <ul className="mt-1 space-y-2">
                        {columnTasks.map((task) => {
                          const session = firstSessionByTask.get(task.id);
                          return (
                            <li key={task.id} data-task-id={task.id} draggable={!saveTask.isPending} onDragEnd={finishDrag}
                              onDragStart={(event) => { setDragging(task); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", task.id); }}
                              className={cn("min-w-0 space-y-2 rounded-lg border border-border/80 bg-card p-2.5 text-card-foreground shadow-xs", dragging?.id === task.id && "opacity-50")}>
                              <button type="button" onClick={() => showTask(task.id)} className="block min-h-8 w-full cursor-pointer rounded-md text-start text-sm font-medium leading-snug wrap-anywhere hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                                {task.title}
                              </button>
                              <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                                <UserRound className="size-3.5 shrink-0" aria-hidden /><span className="truncate" title={taskAssigneeLabel(task.assignee, props.roles)}>{taskAssigneeLabel(task.assignee, props.roles)}</span>
                              </p>
                              {task.deliverables.length ? (
                                <ul aria-label={taskText("deliverables")} className="space-y-1 border-t border-border/70 pt-2">
                                  {task.deliverables.slice(0, 3).map((item, index) => (
                                    <li key={`${item.kind}/${item.path}/${index}`}><TaskDeliverableAction item={item} onOpen={(item) => void openDeliverable(item)} /></li>
                                  ))}
                                  {task.deliverables.length > 3 ? <li>
                                    <Button type="button" size="xs" variant="ghost" className="px-0" onClick={() => showTask(task.id)}>
                                      {taskText("deliverables")} +{task.deliverables.length - 3}
                                    </Button>
                                  </li> : null}
                                </ul>
                              ) : null}
                              {session ? <Button type="button" size="sm" variant="ghost" className="w-full min-w-0 justify-start px-0 text-xs"
                                onClick={() => openSession(session.id)}>
                                <MessageSquare className="size-3.5 text-muted-foreground" aria-hidden /><span className="truncate">{session.title || session.id}</span>
                              </Button> : null}
                            </li>
                          );
                        })}
                      </ul>
                    ) : <p className="px-1.5 py-4 text-xs text-muted-foreground">{taskText("noTasks")}</p>}
                  </section>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
      <Dialog open={Boolean(editor || preview)} onOpenChange={(open) => {
        if (open || saveTask.isPending) return;
        if (preview) setPreview(null);
        else setEditor(null);
      }}>
        <DialogContent className="max-h-[86dvh] overflow-y-auto lg:max-w-2xl">
          <DialogHeader className="pe-8">
            <DialogTitle className="text-lg leading-snug wrap-anywhere">
              {preview ? taskDeliverableLabel(preview) : editor?.mode === "create" ? taskText("newTask")
                : !selectedTask ? taskText("taskUnavailable") : editor?.mode === "edit" ? taskText("editTask") : selectedTask.title}
            </DialogTitle>
            <DialogDescription className="wrap-anywhere">{preview?.path ?? props.projectName}</DialogDescription>
          </DialogHeader>
          {preview ? <TaskDeliverablePreview key={preview.path} connection={connection} projectPath={props.projectPath} item={preview}
            onBack={editor ? () => setPreview(null) : undefined} />
            : editor?.mode === "create" || (editor?.mode === "edit" && selectedTask) ? (
              <TaskForm key={selectedTask?.id ?? "new"} task={selectedTask} items={items} roles={props.roles} busy={saveTask.isPending} onSave={save}
                onCancel={() => selectedTask ? showTask(selectedTask.id) : setEditor(null)} />
            ) : selectedTask ? (
              <TaskDetail key={selectedTask.id} task={selectedTask} items={items} roles={props.roles} sessions={props.sessions}
                onShowTask={showTask} onOpenDeliverable={(item) => void openDeliverable(item)} onOpenSession={openSession}
                onStartSession={props.onStartSession} onBindSession={props.onBindSession} onUnbindSession={props.onUnbindSession}
                onEdit={() => setEditor({ mode: "edit", id: selectedTask.id })} />
            ) : null}
          {dialogError ? <p role="alert" className="text-sm text-destructive">{dialogError}</p> : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
