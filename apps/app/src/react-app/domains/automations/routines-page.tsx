/** @jsxImportSource react */
import { automationLocalDateTimeInput, formatAutomationSchedule, formatAutomationWeekdays } from "@openwork/types/automation-schedule";
import { automationModelSchema, automationScheduleSchema, type AutomationModel, type AutomationRunStatus, type AutomationRunTrigger } from "@openwork/types/automations";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight, Clock3, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { currentLocale } from "@/i18n";

import { useAiopc } from "../aiopc/aiopc-client";
import { AiopcUnavailable } from "../aiopc/aiopc-status";
import {
  AutomationScheduleFields, AutomationTimezoneField, ScheduleSelect, routineCopy, type LocalAutomationSchedule,
} from "./automation-schedule-fields";

type RoutineDraft = {
  name: string;
  instructions: string;
  agent: string | null;
  schedule: LocalAutomationSchedule;
  model: AutomationModel | null;
};

type Routine = RoutineDraft & {
  id: string;
  state: "active" | "inactive";
  nextDueAt: number | null;
};

export type RoutineRun = {
  id: string;
  kind: "routine_run";
  routineId: string;
  name: string;
  agent: string | null;
  projectRoot: string;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  scheduledAt: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  result: string | null;
  error: string | null;
};

type RoutineCollection = { items: Routine[]; agents: string[]; canRun: boolean };

function routineUrl(routineId: string) {
  return `/api/routines/${encodeURIComponent(routineId)}`;
}

function timestamp(value: number, timezone: string) {
  return new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: "short", timeStyle: "short", timeZone: timezone,
  }).format(value);
}

function scheduleLabel(schedule: LocalAutomationSchedule) {
  if (currentLocale() !== "zh") return formatAutomationSchedule(schedule, currentLocale());
  const clock = (hour: number, minute = 0) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (schedule.kind === "once") {
    return `单次 · ${automationLocalDateTimeInput(schedule.at, schedule.timezone).replace("T", " ")} · ${schedule.timezone}`;
  }
  if (schedule.kind === "daily") return `每天 · ${clock(schedule.hour, schedule.minute)} · ${schedule.timezone}`;
  const days = formatAutomationWeekdays(schedule.daysOfWeek, "zh");
  if (schedule.kind === "weekly") return `每周 · ${days} · ${clock(schedule.hour, schedule.minute)} · ${schedule.timezone}`;
  return `每 ${schedule.everyHours} 小时 · ${days} · ${clock(schedule.startHour)}–${clock(schedule.endHour)} · ${schedule.timezone}`;
}

const statusLabels = {
  queued: ["等待运行", "Queued"], claimed: ["准备运行", "Starting"], running: ["运行中", "Running"],
  succeeded: ["已完成", "Completed"], failed: ["运行失败", "Failed"], cancelled: ["已取消", "Cancelled"],
  skipped: ["已跳过", "Skipped"],
} as const satisfies Record<AutomationRunStatus, readonly [string, string]>;

const triggerLabels = {
  scheduled: ["按计划", "Scheduled"], recovery: ["重启补跑", "Recovery"], manual: ["手动", "Manual"],
} as const satisfies Record<AutomationRunTrigger, readonly [string, string]>;

function localizedLabel([zh, en]: readonly [string, string]) {
  return routineCopy(zh, en);
}

function newDraft(): RoutineDraft {
  return {
    name: "", instructions: "", agent: null, model: null,
    schedule: { kind: "daily", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", hour: 9, minute: 0 },
  };
}

function RoutineEditor(props: {
  routine: Routine | null;
  agents: string[];
  pending: boolean;
  onClose: () => void;
  onSave: (draft: RoutineDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => props.routine ?? newDraft());
  const [modelName, setModelName] = useState(() => draft.model ? `${draft.model.providerId}/${draft.model.modelId}` : "");
  const [error, setError] = useState("");
  const agents = draft.agent && !props.agents.includes(draft.agent) ? [...props.agents, draft.agent] : props.agents;
  const set = <Key extends keyof RoutineDraft>(key: Key, value: RoutineDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const schedule = automationScheduleSchema.safeParse(draft.schedule);
    if (!schedule.success || schedule.data.kind === "calendar") {
      setError(routineCopy("请检查调度时间和时区。", "Check the schedule and timezone."));
      return;
    }
    let model: AutomationModel | null = null;
    if (modelName.trim()) {
      const [providerId, ...parts] = modelName.trim().split("/");
      const parsed = automationModelSchema.safeParse({ providerId, modelId: parts.join("/"), variant: draft.model?.variant });
      if (!parsed.success) {
        setError(routineCopy("请用提供商/模型的格式填写。", "Enter a model in provider/model format."));
        return;
      }
      model = parsed.data;
    }
    try {
      await props.onSave({ name: draft.name, instructions: draft.instructions, agent: draft.agent, schedule: schedule.data, model });
    } catch (err) {
      setError(err instanceof Error ? err.message : routineCopy("保存失败", "Couldn't save the routine"));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !props.pending) props.onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto lg:max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.routine ? routineCopy("编辑例行任务", "Edit routine") : routineCopy("新建例行任务", "New routine")}</DialogTitle>
          <DialogDescription>{routineCopy("设置执行角色、任务说明和运行时间。", "Choose the role, instructions, and schedule.")}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-2">
            <Label htmlFor="routine-name">{routineCopy("名称", "Name")}</Label>
            <Input id="routine-name" required maxLength={120} value={draft.name} onChange={(event) => set("name", event.currentTarget.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="routine-instructions">{routineCopy("任务说明", "Instructions")}</Label>
            <Textarea id="routine-instructions" className="min-h-24" required maxLength={100_000} value={draft.instructions}
              onChange={(event) => set("instructions", event.currentTarget.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="routine-agent">{routineCopy("执行角色", "Role")}</Label>
              <ScheduleSelect id="routine-agent" value={draft.agent ?? ""}
                items={[{ value: "", label: routineCopy("默认角色", "Default role") }, ...agents.map((agent) => ({ value: agent, label: agent }))]}
                onChange={(value) => set("agent", value || null)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="routine-model">{routineCopy("模型（可选）", "Model (optional)")}</Label>
              <Input id="routine-model" value={modelName} placeholder={routineCopy("使用本地默认模型", "Use local default model")}
                onChange={(event) => setModelName(event.currentTarget.value)} />
            </div>
          </div>
          <AutomationScheduleFields schedule={draft.schedule} onChange={(value) => set("schedule", value)} idPrefix="routine" />
          <AutomationTimezoneField timezone={draft.schedule.timezone} idPrefix="routine"
            onChange={(timezone) => set("schedule", { ...draft.schedule, timezone })} />
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={props.pending} onClick={props.onClose}>{routineCopy("取消", "Cancel")}</Button>
            <Button type="submit" disabled={props.pending}>{routineCopy("保存", "Save")}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type RoutineAction = "run" | "pause" | "resume" | "delete";

function RoutineDetails(props: {
  routine: Routine;
  projectRoot: string;
  canRun: boolean;
  onClose: () => void;
  onEdit: () => void;
  onAction: (action: RoutineAction) => Promise<unknown>;
  pending: boolean;
}) {
  const { request, ready } = useAiopc(props.projectRoot);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const { routine } = props;
  const runs = useQuery({
    queryKey: ["aiopc", props.projectRoot, "routine-runs", routine.id],
    enabled: ready,
    queryFn: () => request<{ items: RoutineRun[] }>("GET", `${routineUrl(routine.id)}/runs`),
    refetchInterval: 2000,
  });
  const running = runs.data?.items.some((run) => run.status === "queued" || run.status === "running");
  const act = async (action: RoutineAction) => {
    setError("");
    try {
      await props.onAction(action);
    } catch (err) {
      setError(err instanceof Error ? err.message : routineCopy("操作失败", "The action failed"));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !props.pending) props.onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto lg:max-w-xl">
        <DialogHeader>
          <DialogTitle className="break-words">{routine.name}</DialogTitle>
          <DialogDescription>{scheduleLabel(routine.schedule)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
            <span>{routine.agent || routineCopy("默认角色", "Default role")}</span>
            <span>{routine.nextDueAt === null
              ? routineCopy("暂无计划运行", "No upcoming run")
              : routineCopy(`下次运行 ${timestamp(routine.nextDueAt, routine.schedule.timezone)}`,
                `Next run ${timestamp(routine.nextDueAt, routine.schedule.timezone)}`)}</span>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm">{routine.instructions}</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!props.canRun || props.pending || running} onClick={() => void act("run")}>{routineCopy("立即运行", "Run now")}</Button>
            <Button variant="outline" disabled={props.pending} onClick={props.onEdit}>{routineCopy("编辑", "Edit")}</Button>
            {routine.state === "active" || routine.schedule.kind !== "once" || routine.schedule.at > Date.now() ? (
              <Button variant="outline" disabled={props.pending} onClick={() => void act(routine.state === "active" ? "pause" : "resume")}>
                {routine.state === "active" ? routineCopy("暂停", "Pause") : routineCopy("恢复", "Resume")}
              </Button>
            ) : null}
            <Button variant="ghost" disabled={props.pending} onClick={() => setDeleting(true)}>{routineCopy("删除", "Delete")}</Button>
          </div>
          {deleting ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
              <span className="me-auto">{routineCopy("删除这条例行任务？", "Delete this routine?")}</span>
              <Button size="sm" variant="outline" disabled={props.pending} onClick={() => setDeleting(false)}>{routineCopy("取消", "Cancel")}</Button>
              <Button size="sm" variant="destructive" disabled={props.pending} onClick={() => void act("delete")}>{routineCopy("确认删除", "Delete routine")}</Button>
            </div>
          ) : null}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <section className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">{routineCopy("运行记录", "Run history")}</h3>
            {runs.isError ? <p role="alert" className="text-sm text-destructive">{runs.error.message}</p> : null}
            {runs.isPending ? <p className="text-sm text-muted-foreground">{routineCopy("正在加载…", "Loading…")}</p> : null}
            {runs.data?.items.length === 0 ? <p className="text-sm text-muted-foreground">{routineCopy("还没有运行记录", "No runs yet")}</p> : null}
            <ul className="space-y-2">
              {runs.data?.items.map((run) => (
                <li key={run.id} className="rounded-lg border px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                    <span className={run.status === "failed" ? "font-medium text-destructive" : "font-medium"}>{localizedLabel(statusLabels[run.status])}</span>
                    <span className="text-muted-foreground">{localizedLabel(triggerLabels[run.trigger])}</span>
                    <time className="text-muted-foreground" dateTime={new Date(run.createdAt).toISOString()}>
                      {timestamp(run.startedAt ?? run.createdAt, routine.schedule.timezone)}
                    </time>
                  </div>
                  {run.error || run.result ? <p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">{run.error || run.result}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RoutinesPage({ projectRoot }: { projectRoot: string }) {
  return <ProjectRoutines key={projectRoot} projectRoot={projectRoot} />;
}

function ProjectRoutines({ projectRoot }: { projectRoot: string }) {
  const { connection, ready, request, invalidate } = useAiopc(projectRoot);
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const list = useQuery({
    queryKey: ["aiopc", projectRoot, "routines"],
    enabled: ready,
    queryFn: () => request<RoutineCollection>("GET", "/api/routines"),
    refetchInterval: 5000,
  });
  const current = list.data?.items.find((routine) => routine.id === selected);

  const save = useMutation({
    mutationFn: (draft: RoutineDraft) => editor === "edit" && current
      ? request<Routine>("PATCH", routineUrl(current.id), { body: draft })
      : request<Routine>("POST", "/api/routines", { body: draft }),
    onSuccess: async (routine) => {
      await invalidate("routines");
      setSelected(routine.id);
      setEditor(null);
    },
  });
  const update = useMutation({
    mutationFn: async (action: RoutineAction) => {
      if (!current) return;
      const path = routineUrl(current.id);
      if (action === "delete") return request("DELETE", path);
      if (action === "run") return request("POST", `${path}/runs`);
      return request("PATCH", path, { body: { state: action === "pause" ? "inactive" : "active" } });
    },
    onSuccess: async (_, action) => {
      if (action === "delete") setSelected(null);
      await Promise.all([invalidate("routines"), invalidate("routine-runs")]);
    },
  });

  const title = routineCopy("例行任务", "Routines");
  if (!ready) return <AiopcUnavailable connection={connection} title={title} />;
  return (
    <section className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {routineCopy("应用运行时按计划执行，结果进入收件箱。", "Runs on schedule while the app is open. Results go to the inbox.")}
          </p>
        </div>
        <Button disabled={!list.data} onClick={() => setEditor("new")}><Plus />{routineCopy("新建例行任务", "New routine")}</Button>
      </header>
      {list.isError ? <p role="alert" className="text-sm text-destructive">{list.error.message}</p> : null}
      {list.isPending ? <p className="text-sm text-muted-foreground">{routineCopy("正在加载…", "Loading…")}</p> : null}
      {list.data && !list.data.canRun ? (
        <p role="status" className="text-sm text-muted-foreground">{routineCopy("本地调度器未就绪。", "The local scheduler is unavailable.")}</p>
      ) : null}
      {list.data?.items.length === 0 ? (
        <div className="rounded-xl border p-8 text-center text-sm text-muted-foreground">{routineCopy("这个项目还没有例行任务", "This project has no routines yet")}</div>
      ) : null}
      {list.data?.items.length ? (
        <ul className="divide-y overflow-hidden rounded-xl border">
          {list.data.items.map((routine) => (
            <li key={routine.id}>
              <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-muted/50"
                onClick={() => setSelected(routine.id)}>
                <Clock3 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="break-words text-sm font-medium">{routine.name}</div>
                  <div className="mt-1 break-words text-xs text-muted-foreground">{scheduleLabel(routine.schedule)}{routine.agent ? ` · ${routine.agent}` : ""}</div>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {routine.state === "active" ? routineCopy("已启用", "Active") : routineCopy("未启用", "Inactive")}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {editor ? <RoutineEditor key={editor} routine={editor === "edit" ? current ?? null : null} agents={list.data?.agents ?? []}
        pending={save.isPending} onSave={(draft) => save.mutateAsync(draft).then(() => undefined)} onClose={() => setEditor(null)} /> : null}
      {current && !editor ? <RoutineDetails key={current.id} routine={current} projectRoot={projectRoot} canRun={list.data?.canRun ?? false}
        pending={update.isPending} onClose={() => setSelected(null)} onEdit={() => setEditor("edit")}
        onAction={(action) => update.mutateAsync(action)} /> : null}
    </section>
  );
}
