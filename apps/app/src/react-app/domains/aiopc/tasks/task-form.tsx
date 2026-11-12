import { useId, useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { TASK_STATUSES, type ProjectTask, type TaskDeliverable, type TaskFields, type TaskRole, type TaskStatus } from "./task-client";
import { taskError, taskText } from "./task-copy";

export const taskSelectClass = "min-h-9 w-full min-w-0 rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50";

function editableFields(task?: ProjectTask): TaskFields {
  return {
    title: task?.title ?? "",
    description: task?.description ?? "",
    status: task?.requestedStatus ?? task?.status ?? "todo",
    assignee: task?.assignee ?? null,
    parent: task?.parent ?? null,
    blockedBy: task?.blockedBy ?? [],
    deliverables: task?.deliverables ?? [],
  };
}

function changedFields(initial: TaskFields, next: TaskFields): Partial<TaskFields> {
  const fields = Object.keys(next) as (keyof TaskFields)[];
  return Object.fromEntries(fields.filter((field) => JSON.stringify(initial[field]) !== JSON.stringify(next[field]))
    .map((field) => [field, next[field]]));
}

export function TaskForm(props: {
  task?: ProjectTask;
  items: readonly ProjectTask[];
  roles: readonly TaskRole[];
  busy: boolean;
  onSave: (fields: Partial<TaskFields>, expectedUpdatedAt?: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [initial] = useState(() => editableFields(props.task));
  const [expectedUpdatedAt] = useState(props.task?.updatedAt);
  const [fields, setFields] = useState(initial);
  const [error, setError] = useState("");
  const id = useId();
  const otherTasks = props.items.filter((item) => item.id !== props.task?.id);
  const byId = new Map(otherTasks.map((item) => [item.id, item]));
  const dependencies = otherTasks.filter((item) => !fields.blockedBy.includes(item.id));
  const edit = <Key extends keyof TaskFields>(field: Key, value: TaskFields[Key]) => setFields((current) => ({ ...current, [field]: value }));
  const setDeliverable = (index: number, change: Partial<TaskDeliverable>) => {
    edit("deliverables", fields.deliverables.map((item, i) => index === i ? { ...item, ...change } : item));
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (props.busy || !fields.title.trim()) return;
    setError("");
    const next = { ...fields, title: fields.title.trim() };
    const update = props.task ? changedFields(initial, next) : next;
    if (update.deliverables) update.deliverables = update.deliverables.map(({ kind, path, label }) => ({
      kind, path: path.trim(), ...(label?.trim() ? { label: label.trim() } : {}),
    }));
    if (Object.keys(update).length === 0) {
      props.onCancel();
      return;
    }
    try {
      await props.onSave(update, expectedUpdatedAt);
    } catch (error) {
      setError(taskError(error, "saveFailed"));
    }
  }

  return (
    <form className="space-y-4" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={props.busy} className="space-y-4">
        <label className="block space-y-1.5 font-medium">
          <span>{taskText("title")}</span>
          <Input name="title" autoFocus required maxLength={300} value={fields.title} onChange={(event) => edit("title", event.target.value)} />
        </label>
        <label className="block space-y-1.5 font-medium">
          <span>{taskText("description")}</span>
          <Textarea name="description" rows={4} value={fields.description} onChange={(event) => edit("description", event.target.value)} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1.5 font-medium">
            <span>{taskText("status")}</span>
            <select name="status" className={taskSelectClass} value={fields.status} onChange={(event) => edit("status", event.target.value as TaskStatus)}>
              {TASK_STATUSES.map((status) => <option key={status} value={status}>{taskText(status)}</option>)}
            </select>
          </label>
          <label className="block space-y-1.5 font-medium">
            <span>{taskText("assignee")}</span>
            <select name="assignee" className={taskSelectClass} value={fields.assignee ?? ""} onChange={(event) => edit("assignee", event.target.value || null)}>
              <option value="">{taskText("unassigned")}</option>
              {props.roles.map((role) => <option key={role.name} value={role.name}>{role.label ?? role.name}</option>)}
              {fields.assignee && !props.roles.some((role) => role.name === fields.assignee)
                ? <option value={fields.assignee}>{fields.assignee}</option> : null}
            </select>
          </label>
        </div>
        {otherTasks.length || fields.parent ? (
          <label className="block space-y-1.5 font-medium">
            <span>{taskText("parent")}</span>
            <select name="parent" className={taskSelectClass} value={fields.parent ?? ""} onChange={(event) => edit("parent", event.target.value || null)}>
              <option value="">{taskText("noParent")}</option>
              {otherTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
              {fields.parent && !byId.has(fields.parent) ? <option value={fields.parent}>{fields.parent}</option> : null}
            </select>
          </label>
        ) : null}
        {otherTasks.length || fields.blockedBy.length ? (
          <fieldset className="space-y-2">
            <legend className="font-medium">{taskText("blockedBy")}</legend>
            {fields.blockedBy.length ? (
              <ul className="flex flex-wrap gap-2">
                {fields.blockedBy.map((blockedBy) => (
                  <li key={blockedBy} className="max-w-full">
                    <Button type="button" size="sm" variant="outline" className="max-w-full" onClick={() => edit("blockedBy", fields.blockedBy.filter((value) => value !== blockedBy))}
                      aria-label={`${taskText("remove")} ${byId.get(blockedBy)?.title ?? blockedBy}`}>
                      <span className="truncate">{byId.get(blockedBy)?.title ?? blockedBy}</span><X className="size-3" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {dependencies.length ? (
              <select name="dependency" value="" aria-label={taskText("chooseDependency")} aria-describedby={`${id}-dependencies`} className={taskSelectClass}
                onChange={(event) => { if (event.target.value) edit("blockedBy", [...fields.blockedBy, event.target.value]); }}>
                <option value="">{taskText("chooseDependency")}</option>
                {dependencies.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
              </select>
            ) : null}
            <p id={`${id}-dependencies`} className="text-xs text-muted-foreground">{taskText("dependencyHint")}</p>
          </fieldset>
        ) : null}
        <fieldset className="space-y-2">
          <legend className="font-medium">{taskText("deliverables")}</legend>
          {fields.deliverables.map((item, index) => (
            <div key={index} className="grid items-end gap-2 rounded-xl border border-border bg-muted/15 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <label className="block space-y-1.5 sm:col-span-3">
                <span>{taskText("deliverablePath")}</span>
                <Input required value={item.path} placeholder="content/launch.md" onChange={(event) => setDeliverable(index, { path: event.target.value })} />
              </label>
              <label className="block space-y-1.5">
                <span>{taskText("deliverableKind")}</span>
                <select value={item.kind} className={taskSelectClass} onChange={(event) => setDeliverable(index, { kind: event.target.value as TaskDeliverable["kind"] })}>
                  <option value="file">{taskText("file")}</option>
                  <option value="publish">{taskText("publish")}</option>
                </select>
              </label>
              <label className="block space-y-1.5">
                <span>{taskText("deliverableLabel")}</span>
                <Input value={item.label ?? ""} onChange={(event) => setDeliverable(index, { label: event.target.value })} />
              </label>
              <Button type="button" variant="outline" onClick={() => edit("deliverables", fields.deliverables.filter((_, i) => i !== index))}>
                {taskText("remove")}
              </Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="outline" onClick={() => edit("deliverables", [...fields.deliverables, { kind: "file", path: "" }])}>
            <Plus className="size-3.5" aria-hidden />{taskText("addDeliverable")}
          </Button>
        </fieldset>
      </fieldset>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="outline" disabled={props.busy} onClick={props.onCancel}>{taskText("cancel")}</Button>
        <Button type="submit" disabled={props.busy || !fields.title.trim()}>{taskText(props.busy ? "saving" : props.task ? "save" : "create")}</Button>
      </div>
    </form>
  );
}
