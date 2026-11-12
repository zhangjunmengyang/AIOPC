import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAiopc } from "../aiopc-client";

export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskDeliverable = { kind: "file" | "publish"; path: string; label?: string | null };
export type TaskRole = { name: string; label?: string };
export type TaskSession = { id: string; title: string; taskId?: string | null };
export type TaskFields = {
  title: string;
  description: string;
  status: TaskStatus;
  assignee: string | null;
  parent: string | null;
  blockedBy: string[];
  deliverables: TaskDeliverable[];
};
export type ProjectTask = TaskFields & {
  id: string;
  requestedStatus?: TaskStatus;
  createdAt: string;
  updatedAt: string;
  activity: { id: string; at: string; actor: "user" | "agent"; action: "created" | "updated"; fields: string[] }[];
};
type TaskList = { items: ProjectTask[]; issues?: { file: string; message: string }[] };

export function useProjectTasks(projectPath: string) {
  const { connection, ready, request, invalidate } = useAiopc(projectPath);
  const queryClient = useQueryClient();
  const queryKey = ["aiopc", projectPath, "tasks"];
  const tasks = useQuery({
    queryKey,
    enabled: ready,
    queryFn: () => request<TaskList>("GET", "/api/tasks"),
    refetchInterval: 10_000,
    retry: false,
  });
  const saveTask = useMutation({
    mutationFn: async ({ id, fields, expectedUpdatedAt }: { id?: string; fields: Partial<TaskFields>; expectedUpdatedAt?: string }) => {
      const result = await request<{ item: ProjectTask }>(
        id ? "PATCH" : "POST", id ? `/api/tasks/${encodeURIComponent(id)}` : "/api/tasks", { body: { ...fields, expectedUpdatedAt } },
      );
      return result.item;
    },
    onSuccess: async (item) => {
      queryClient.setQueryData<TaskList>(queryKey, (current) => {
        if (!current) return { items: [item] };
        const items = current.items.some((task) => task.id === item.id)
          ? current.items.map((task) => task.id === item.id ? item : task)
          : [...current.items, item];
        return { ...current, items };
      });
      await invalidate("tasks");
    },
  });
  return { connection, tasks, saveTask };
}

export function taskDeliverableLabel(deliverable: TaskDeliverable) {
  return deliverable.label?.trim() || deliverable.path.split("/").at(-1) || deliverable.path;
}

export function taskDeliverableAbsolutePath(projectPath: string, item: TaskDeliverable) {
  if (item.kind !== "file" && item.kind !== "publish") return "";
  const path = item.path;
  if (typeof path !== "string" || path.startsWith("/") || /[\\:\u0000-\u001f]/.test(path)) return "";
  const segments = path.split("/").filter((part) => part && part !== ".");
  if (!segments.length || segments.includes("..")) return "";
  const separator = projectPath.includes("\\") && !projectPath.includes("/") ? "\\" : "/";
  return `${projectPath.replace(/[/\\]+$/, "")}${separator}${segments.join(separator)}`;
}
