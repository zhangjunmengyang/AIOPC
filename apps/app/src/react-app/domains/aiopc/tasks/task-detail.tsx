import { useState } from "react";
import { FileText, MessageSquare, Newspaper, Unlink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MarkdownBlock } from "@/components/markdown/markdown";
import { currentLocale } from "@/i18n";

import { type ProjectTask, type TaskDeliverable, type TaskRole, type TaskSession, taskDeliverableLabel } from "./task-client";
import { taskError, taskText } from "./task-copy";
import { taskSelectClass } from "./task-form";

type TaskConversationActions = {
  onOpenSession: (sessionId: string) => void;
  onStartSession?: (task: ProjectTask) => void | Promise<void>;
  onBindSession?: (taskId: string, sessionId: string) => Promise<void>;
  onUnbindSession?: (taskId: string, sessionId: string) => Promise<void>;
};

export type TaskDetailProps = TaskConversationActions & {
  task: ProjectTask;
  items: readonly ProjectTask[];
  roles: readonly TaskRole[];
  sessions: readonly TaskSession[];
  onShowTask: (id: string) => void;
  onOpenDeliverable: (deliverable: TaskDeliverable) => void;
  onEdit: () => void;
};

const knownFields = new Set(["title", "description", "status", "assignee", "parent", "blockedBy", "deliverables"] as const);
type EditableField = typeof knownFields extends Set<infer Field> ? Field : never;

export function taskAssigneeLabel(assignee: string | null, roles: readonly TaskRole[]) {
  return assignee ? roles.find((role) => role.name === assignee)?.label || assignee : taskText("unassigned");
}

export function TaskDeliverableAction({ item, onOpen }: { item: TaskDeliverable; onOpen: (item: TaskDeliverable) => void }) {
  const Icon = item.kind === "publish" ? Newspaper : FileText;
  return (
    <Button type="button" size="sm" variant="outline" title={item.path} className="max-w-full justify-start gap-1.5 rounded-lg border-border/70 bg-muted/30 px-2.5 text-xs"
      onClick={() => onOpen(item)}>
      <Icon className="size-3.5 text-muted-foreground" aria-hidden />
      <span className="truncate">{taskDeliverableLabel(item)}</span>
    </Button>
  );
}

function TaskConversations({ task, sessions, onOpenSession, onStartSession, onBindSession, onUnbindSession }:
  TaskConversationActions & Pick<TaskDetailProps, "task" | "sessions">) {
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const linked = sessions.filter((session) => session.taskId === task.id);
  const available = sessions.filter((session) => !session.taskId);
  const selectedSession = available.find((session) => session.id === selected);

  async function run(action: () => void | Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(taskError(error, "conversationFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2.5 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{taskText("conversations")}</h3>
        {onStartSession ? (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run(() => onStartSession(task))}>
            <MessageSquare className="size-3.5" aria-hidden />{taskText("startConversation")}
          </Button>
        ) : null}
      </div>
      {linked.length ? (
        <ul className="divide-y divide-border/60">
          {linked.map((session) => (
            <li key={session.id} className="flex items-center gap-1 py-1">
              <Button type="button" size="sm" variant="ghost" className="min-w-0 flex-1 justify-start px-0" onClick={() => onOpenSession(session.id)}>
                <MessageSquare className="size-3.5 text-muted-foreground" aria-hidden /><span className="truncate">{session.title || session.id}</span>
              </Button>
              {onUnbindSession ? (
                <Button type="button" size="icon-sm" variant="ghost" disabled={busy} title={taskText("unlinkConversation")}
                  aria-label={`${taskText("unlinkConversation")} ${session.title || session.id}`} onClick={() => void run(() => onUnbindSession(task.id, session.id))}>
                  <Unlink className="size-3.5 text-muted-foreground" aria-hidden />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted-foreground">{taskText("noConversations")}</p>}
      {onBindSession && available.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <select name="conversation" className={`${taskSelectClass} w-auto max-w-full flex-1 basis-52`} aria-label={taskText("chooseConversation")}
            value={selectedSession?.id ?? ""} disabled={busy} onChange={(event) => setSelected(event.target.value)}>
            <option value="">{taskText("chooseConversation")}</option>
            {available.map((session) => <option key={session.id} value={session.id}>{session.title || session.id}</option>)}
          </select>
          <Button type="button" size="sm" variant="outline" disabled={busy || !selectedSession} onClick={() => void run(async () => {
            if (!selectedSession) return;
            await onBindSession(task.id, selectedSession.id);
            setSelected("");
          })}>{taskText("linkConversation")}</Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}

function TaskActivity({ activity }: { activity: ProjectTask["activity"] }) {
  const dateFormat = new Intl.DateTimeFormat(currentLocale(), { dateStyle: "medium", timeStyle: "short" });
  const listFormat = new Intl.ListFormat(currentLocale(), { type: "conjunction" });
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <h3 className="font-medium">{taskText("activity")}</h3>
      {activity.length ? (
        <ol className="space-y-3 border-s border-border ps-4">
          {activity.toSorted((a, b) => b.at.localeCompare(a.at)).map((item) => {
            const label = item.action === "created" ? (item.actor === "agent" ? "createdByAgent" : "createdByUser")
              : (item.actor === "agent" ? "updatedByAgent" : "updatedByUser");
            const fields = item.action === "updated" ? item.fields.map((field) => knownFields.has(field as EditableField) ? taskText(field as EditableField) : field) : [];
            const date = new Date(item.at);
            return (
              <li key={item.id} className="relative before:absolute before:top-1.5 before:-start-[20px] before:size-1.5 before:rounded-full before:bg-muted-foreground">
                <p>{taskText(label)}{fields.length ? <span className="text-muted-foreground"> · {listFormat.format(fields)}</span> : null}</p>
                <time dateTime={item.at} className="text-xs text-muted-foreground">{Number.isNaN(date.getTime()) ? item.at : dateFormat.format(date)}</time>
              </li>
            );
          })}
        </ol>
      ) : <p className="text-sm text-muted-foreground">{taskText("noActivity")}</p>}
    </section>
  );
}

export function TaskDetail(props: TaskDetailProps) {
  const { task, items, roles } = props;
  const byId = new Map(items.map((item) => [item.id, item]));
  const relatedTask = (id: string) => {
    const related = byId.get(id);
    return related ? <Button type="button" size="sm" variant="ghost" className="h-auto min-h-7 max-w-full justify-start whitespace-normal px-0 text-left"
      onClick={() => props.onShowTask(id)}>{related.title}</Button> : id;
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          <div><dt className="text-xs text-muted-foreground">{taskText("status")}</dt><dd className="mt-0.5">{taskText(task.status)}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-muted-foreground">{taskText("assignee")}</dt><dd className="mt-0.5 wrap-anywhere">{taskAssigneeLabel(task.assignee, roles)}</dd></div>
          {task.parent ? <div className="min-w-0 wrap-anywhere"><dt className="text-xs text-muted-foreground">{taskText("parent")}</dt><dd>{relatedTask(task.parent)}</dd></div> : null}
        </dl>
        <Button type="button" size="sm" variant="outline" onClick={props.onEdit}>{taskText("editTask")}</Button>
      </div>
      {task.description ? <MarkdownBlock className="min-w-0 text-sm" text={task.description} /> : null}
      {task.blockedBy.length ? (
        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="font-medium">{taskText("blockedBy")}</h3>
          <ul className="divide-y divide-border/60">
            {task.blockedBy.map((id) => {
              const related = byId.get(id);
              return (
                <li key={id} className="flex flex-wrap items-center justify-between gap-1 py-1.5 wrap-anywhere">
                  {relatedTask(id)}{related ? <span className="text-xs text-muted-foreground">{taskText(related.status)}</span> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {task.deliverables.length ? (
        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="font-medium">{taskText("deliverables")}</h3>
          <ul className="flex flex-wrap gap-1.5">
            {task.deliverables.map((item, index) => (
              <li key={`${item.kind}/${item.path}/${index}`} className="max-w-full">
                <TaskDeliverableAction item={item} onOpen={props.onOpenDeliverable} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <TaskConversations {...props} />
      <TaskActivity activity={task.activity} />
    </div>
  );
}
