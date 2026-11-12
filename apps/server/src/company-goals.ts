import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { listCompanyProjects, type CompanyProject } from "./company-projects.js";
import { ApiError } from "./errors.js";
import { runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { createWorkspaceKvStore } from "./workspace-kv-store.js";

export const GOAL_STATUSES = ["planned", "active", "achieved", "cancelled"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type CompanyGoal = {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  projectId: string | null;
  parentId: string | null;
};

export type GoalTaskLink = { projectId: string; taskId: string; goalId: string };
type CompanyGoalState = { items: CompanyGoal[]; links: GoalTaskLink[] };
export type CompanyGoalSnapshot = CompanyGoalState & { projects: CompanyProject[] };
type Company = Pick<WorkspaceInfo, "id" | "path">;

const emptyState: CompanyGoalState = { items: [], links: [] };
const store = createWorkspaceKvStore<CompanyGoalState>({
  tableName: "company_goals",
  valueColumn: "state_json",
  parse: (json) => JSON.parse(json) as CompanyGoalState,
  serialize: JSON.stringify,
});
const pendingWrites = new Map<string, Promise<void>>();

export async function readCompanyGoals(config: ServerConfig, company: Company): Promise<CompanyGoalSnapshot> {
  const [state, projects] = await Promise.all([store.get(config, company.id), listCompanyProjects(company.path)]);
  return { ...(state ?? emptyState), projects };
}

async function updateCompanyGoals(
  config: ServerConfig,
  company: Company,
  update: (snapshot: CompanyGoalSnapshot) => CompanyGoalState,
): Promise<CompanyGoalSnapshot> {
  const key = JSON.stringify([runtimeDbPath(config), company.id]);
  const prior = pendingWrites.get(key) ?? Promise.resolve();
  const result = prior.then(async () => {
    const snapshot = await readCompanyGoals(config, company);
    const state = update(snapshot);
    await store.set(config, company.id, state);
    return { ...state, projects: snapshot.projects };
  });
  const settled = result.then(() => undefined, () => undefined);
  pendingWrites.set(key, settled);
  try {
    return await result;
  } finally {
    if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
  }
}

function requireGoal(items: CompanyGoal[], goalId: string): CompanyGoal {
  const goal = items.find((item) => item.id === goalId);
  if (!goal) throw new ApiError(404, "goal_not_found", "目标不存在");
  return goal;
}

function requireProject(projects: CompanyProject[], projectId: string): CompanyProject {
  const project = projects.find((item) => item.id === projectId);
  if (!project) throw new ApiError(404, "project_not_found", "当前公司中没有此项目");
  return project;
}

function nullableId(value: unknown, label: string): string | null {
  if (value === null || (typeof value === "string" && value.trim() && value.length <= 256)) return value;
  throw new ApiError(400, "invalid_goal", `${label}无效`);
}

function editGoal(fields: Record<string, unknown>, current?: CompanyGoal): CompanyGoal {
  const title = Object.hasOwn(fields, "title") ? fields.title : current?.title;
  if (typeof title !== "string" || !title.trim() || title.trim().length > 300) {
    throw new ApiError(400, "invalid_goal", "请输入 1 到 300 字的目标名称");
  }
  const description = Object.hasOwn(fields, "description") ? fields.description : current?.description ?? "";
  if (typeof description !== "string" || description.length > 20_000) {
    throw new ApiError(400, "invalid_goal", "目标说明不能超过 20000 字");
  }
  const status = Object.hasOwn(fields, "status") ? fields.status : current?.status ?? "planned";
  if (!GOAL_STATUSES.some((allowed) => status === allowed)) {
    throw new ApiError(400, "invalid_goal", "目标状态无效");
  }
  const projectId = Object.hasOwn(fields, "projectId") ? nullableId(fields.projectId, "项目") : current?.projectId ?? null;
  const parentId = Object.hasOwn(fields, "parentId") ? nullableId(fields.parentId, "公司目标") : current?.parentId ?? null;
  if (current && current.projectId !== projectId) {
    throw new ApiError(400, "invalid_goal", "保存后不能更改目标所属项目");
  }
  return { id: current?.id ?? randomUUID(), title: title.trim(), description, status: status as GoalStatus, projectId, parentId };
}

export function saveCompanyGoal(
  config: ServerConfig, company: Company, fields: Record<string, unknown>, goalId?: string,
): Promise<CompanyGoalSnapshot> {
  return updateCompanyGoals(config, company, ({ items, links, projects }) => {
    const goal = editGoal(fields, goalId ? requireGoal(items, goalId) : undefined);
    if (goal.projectId === null) {
      if (goal.parentId !== null) throw new ApiError(400, "invalid_goal_parent", "公司目标位于目标树顶层");
    } else {
      requireProject(projects, goal.projectId);
      const parent = items.find((item) => item.id === goal.parentId && item.projectId === null);
      if (!parent) throw new ApiError(400, "invalid_goal_parent", "请选择一个公司目标");
    }
    return { items: goalId ? items.map((item) => item.id === goalId ? goal : item) : [...items, goal], links };
  });
}

async function requireTask(project: CompanyProject, taskId: string): Promise<void> {
  const directory = join(project.directory, "tasks");
  if ((await lstat(directory).catch(() => null))?.isDirectory()
      && (await lstat(join(directory, `${taskId}.md`)).catch(() => null))?.isFile()) return;
  throw new ApiError(404, "task_not_found", "当前项目中没有此任务");
}

export async function setCompanyGoalTaskLink(
  config: ServerConfig, company: Company, projectId: string, taskId: string, value: unknown,
): Promise<CompanyGoalSnapshot> {
  // Match the Markdown task store's filename contract. Task files stay read-only here.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(taskId)) {
    throw new ApiError(400, "invalid_task_id", "任务 ID 无效");
  }
  const goalId = nullableId(value, "项目目标");
  if (goalId !== null) await requireTask(requireProject(await listCompanyProjects(company.path), projectId), taskId);
  return updateCompanyGoals(config, company, ({ items, links, projects }) => {
    requireProject(projects, projectId);
    if (goalId !== null && requireGoal(items, goalId).projectId !== projectId) {
      throw new ApiError(400, "invalid_goal_task", "任务只能关联同一项目的目标");
    }
    const remaining = links.filter((item) => item.projectId !== projectId || item.taskId !== taskId);
    return { items, links: goalId === null ? remaining : [...remaining, { projectId, taskId, goalId }] };
  });
}
