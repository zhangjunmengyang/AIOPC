import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "./errors.js";

export function isProjectTaskId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

/** The caller supplies an authorized project directory. Never follow task symlinks. */
export async function requireProjectTaskFile(projectDirectory: string, taskId: string): Promise<void> {
  if (!isProjectTaskId(taskId)) throw new ApiError(400, "invalid_task_id", "任务 ID 无效");
  const tasksDirectory = join(projectDirectory, "tasks");
  const directory = await lstat(tasksDirectory).catch(() => null);
  if (directory?.isDirectory()) {
    const file = await lstat(join(tasksDirectory, `${taskId}.md`)).catch(() => null);
    if (file?.isFile()) return;
  }
  throw new ApiError(404, "task_not_found", "当前项目中没有此任务");
}
