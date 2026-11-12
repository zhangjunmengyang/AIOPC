import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ApiError } from "./errors.js";

export type CompanyProject = { id: string; name: string; directory: string };
const execute = promisify(execFile);
const boundarySetup = new Map<string, Promise<void>>();

/** Native engines walk upward for skills/config. Git marks the company boundary. */
export async function ensureCompanyProjectBoundary(companyRoot: string): Promise<void> {
  const company = await realpath(companyRoot);
  if (await lstat(join(company, ".git")).catch(() => null)) return;
  const existing = boundarySetup.get(company);
  if (existing) return existing;
  const pending = execute("git", ["init", "--quiet"], { cwd: company, timeout: 10_000 }).then(() => undefined)
    .catch(() => { throw new ApiError(400, "company_boundary_unavailable", "无法建立公司的 Git 目录边界，请确认 Git 可用且公司目录可写"); });
  boundarySetup.set(company, pending);
  try { await pending; } finally { boundarySetup.delete(company); }
}

export function isCompanyProjectName(value: string): boolean {
  return value.trim() === value && value.length > 0 && Array.from(value).length <= 120
    && !value.startsWith(".") && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

/** A company owns only its root and direct project directories, after resolving links. */
export async function resolveCompanyExecutionDirectory(companyRoot: string, requested: unknown): Promise<string> {
  const company = await realpath(companyRoot).catch(() => resolve(companyRoot));
  if (typeof requested !== "string" || !requested.trim()) return company;
  const candidate = await realpath(isAbsolute(requested) ? requested : resolve(company, requested)).catch(() => null);
  if (!candidate || candidate === company) return company;
  const parts = relative(company, candidate).split(sep);
  if (parts.length !== 2 || parts[0] !== "projects" || !isCompanyProjectName(parts[1] ?? "")) return company;
  return (await stat(candidate).catch(() => null))?.isDirectory() ? candidate : company;
}

export async function listCompanyProjects(companyRoot: string): Promise<CompanyProject[]> {
  const company = await realpath(companyRoot).catch(() => resolve(companyRoot));
  const folder = join(company, "projects");
  if ((await lstat(folder).catch(() => null))?.isSymbolicLink()) return [];
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const projects: CompanyProject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isCompanyProjectName(entry.name)) continue;
    const directory = await resolveCompanyExecutionDirectory(company, join(folder, entry.name));
    if (directory !== company) projects.push({ id: `proj:${entry.name}`, name: entry.name, directory });
  }
  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

export async function createCompanyProject(companyRoot: string, name: string): Promise<CompanyProject> {
  if (!isCompanyProjectName(name)) throw new ApiError(400, "invalid_project_name", "项目名称不能包含路径、隐藏前缀或控制字符");
  const company = await realpath(companyRoot);
  const folder = join(company, "projects");
  if ((await lstat(folder).catch(() => null))?.isSymbolicLink()) {
    throw new ApiError(400, "invalid_project_directory", "项目目录不能使用符号链接");
  }
  await mkdir(folder, { recursive: true });
  const directory = join(folder, name);
  if ((await lstat(directory).catch(() => null))?.isSymbolicLink()) {
    throw new ApiError(400, "invalid_project_directory", "项目目录不能使用符号链接");
  }
  await mkdir(directory, { recursive: true });
  if (await resolveCompanyExecutionDirectory(company, directory) !== directory) {
    throw new ApiError(400, "invalid_project_directory", "项目必须位于公司 projects 目录内");
  }
  await ensureCompanyProjectBoundary(company);
  return { id: `proj:${name}`, name, directory };
}

/** A v1 engine serves multiple workspaces, so its CWD and Git root cannot identify every company. */
export async function companyDirectoryForExecution(
  directory: string,
  worktree?: string,
  sessionId?: string,
): Promise<string | null> {
  const execution = await realpath(directory).catch(() => resolve(directory));
  if (basename(dirname(execution)) !== "projects") return directory;
  const parent = dirname(dirname(execution));
  const host = process.env.OPENWORK_SERVER_URL?.trim();
  const token = process.env.OPENWORK_SERVER_TOKEN?.trim();
  if (!host || !token) {
    return worktree && (await realpath(worktree).catch(() => resolve(worktree))) === parent ? parent : null;
  }

  const signal = AbortSignal.timeout(1500);
  const read = async <T>(path: string): Promise<T | null> => {
    try {
      const response = await fetch(new URL(path, host), {
        headers: { Authorization: `Bearer ${token}` }, signal, redirect: "error",
      });
      return response.ok ? await response.json() as T : null;
    } catch { return null; }
  };
  const workspaces = await read<{ items?: Array<{ id?: string; path?: string }> }>("/workspaces");
  if (!Array.isArray(workspaces?.items)) return null;
  const candidates = (await Promise.all(workspaces.items.map(async (item) => {
    if (typeof item?.id !== "string" || !item.id || typeof item.path !== "string" || !isAbsolute(item.path)) return null;
    const root = await realpath(item.path).catch(() => null);
    if (root === execution) return { id: item.id, root: directory, projectId: null };
    if (root === parent) return { id: item.id, root, projectId: `proj:${basename(execution)}` };
    return null;
  }))).filter(candidate => candidate !== null);
  const roots = new Set(candidates.map(candidate => candidate.root));
  if (roots.size <= 1) return candidates[0]?.root ?? null;
  if (!sessionId) return null;

  // The same folder can be both an imported company and a project of its
  // parent. Read existing metadata without asking either engine to adopt it.
  const matches = new Set(await Promise.all(candidates.map(async ({ id, root, projectId }) => {
    const groups = await read<{ state?: { sessionMeta?: Record<string, { projectId?: string | null }> } }>(
      `/workspace/${encodeURIComponent(id)}/session-groups`,
    );
    return groups?.state?.sessionMeta?.[sessionId]?.projectId === projectId ? root : null;
  })));
  matches.delete(null);
  return matches.size === 1 ? matches.values().next().value ?? null : null;
}

export function companyProjectInstructions(companyDirectory: string, executionDirectory: string): string {
  const company = resolve(companyDirectory);
  const execution = resolve(executionDirectory);
  return `当前公司目录：${JSON.stringify(company)}。当前执行目录：${JSON.stringify(execution)}。`
    + (execution === company
      ? "这是公司级会话；项目工具的 project 参数只在明确选择 projects 下的项目后传入。"
      : `当前项目目录：${JSON.stringify(execution)}。调用 AIOPC 的项目工具时必须传 project=${JSON.stringify(execution)}；不要使用其他项目的资料、账号或环境。`);
}
