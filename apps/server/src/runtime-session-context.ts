import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readRoleSkillPolicy } from "./company-roles.js";
import { ApiError } from "./errors.js";
import { createV2SessionHomes, nativeSession, nativeSessionDirectory, type V2SessionOrigin } from "./opencode-v2-session-home.js";
import { readSessionGroupState, resolveSessionProject } from "./session-groups.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { isRecord } from "./workspace-kv-store.js";

type Runtime = { id: string; token: string; file?: string };
const runtimes = new WeakMap<ServerConfig, Runtime>();
function runtime(config: ServerConfig): Runtime {
  let value = runtimes.get(config);
  if (!value) { value = { id: randomUUID(), token: randomBytes(32).toString("base64url") }; runtimes.set(config, value); }
  return value;
}
export function beginRuntimeSessionContext(config: ServerConfig): void { runtimes.delete(config); runtime(config); }
export function runtimeIdForConfig(config: ServerConfig): string { return runtime(config).id; }
/** Only host lifecycle dispatch uses this scoped capability; never serialize it into tool input. */
export function runtimeTokenForConfig(config: ServerConfig): string { return runtime(config).token; }

function sameSecret(value: string | null, secret: string | undefined): boolean {
  if (!value || !secret) return false;
  const left = Buffer.from(value), right = Buffer.from(secret);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/** This capability grants only trusted session lookup, never other host routes. */
export function authorizeRuntimeContextRequest(request: Request, config: ServerConfig): boolean {
  return sameSecret(request.headers.get("x-aiopc-runtime-token"), runtime(config).token)
    || sameSecret(request.headers.get("x-openwork-host-token"), config.hostToken);
}

export function runtimeContextFileForConfig(config: ServerConfig): string {
  return join(process.env.AIOPC_HOME?.trim() || join(homedir(), ".aiopc"), "runtime-context", `${runtime(config).id}.json`);
}

export async function writeRuntimeContextFile(config: ServerConfig, url: string, file?: string): Promise<string> {
  const value = runtime(config);
  const destination = file ?? runtimeContextFileForConfig(config);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ url, token: value.token, runtimeId: value.id }), { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    value.file = destination;
    return destination;
  } finally { await rm(temporary, { force: true }); }
}

export async function removeRuntimeContextFile(config: ServerConfig): Promise<void> {
  const file = runtimes.get(config)?.file;
  if (file) await rm(file, { force: true });
}

export async function resolveRuntimeSessionContext(
  config: ServerConfig, sessionId: string,
  read: (path: string, workspace: WorkspaceInfo) => Promise<unknown>,
  origin?: V2SessionOrigin,
) {
  if (!/^ses_[a-zA-Z0-9_-]{1,250}$/.test(sessionId)) throw new ApiError(400, "invalid_session_id", "会话编号无效");
  let unavailable: unknown;
  for (const workspace of config.workspaces) {
    if (!workspace.path?.trim()) continue;
    try {
      const homes = createV2SessionHomes(config, path => read(path, workspace), origin);
      const value = await read(`/api/session/${encodeURIComponent(sessionId)}`, workspace);
      const session = nativeSession(value);
      if (session?.id !== sessionId || (isRecord(session.time) && session.time.archived)) continue;
      if (await homes.resolveCompany(value, workspace.path) !== await homes.canonical(workspace.path)) continue;
      const project = await resolveSessionProject(config, workspace, sessionId, nativeSessionDirectory(value) ?? undefined);
      const ancestors: string[] = [];
      const seen = new Set([sessionId]);
      let parentId = typeof session.parentID === "string" ? session.parentID : undefined;
      while (parentId) {
        if (seen.has(parentId) || ancestors.length >= 64) throw new ApiError(409, "invalid_session_parent", "会话父级关系无效");
        seen.add(parentId);
        const parentValue = await read(`/api/session/${encodeURIComponent(parentId)}`, workspace);
        const parent = nativeSession(parentValue);
        if (parent?.id !== parentId || await homes.resolveCompany(parentValue, workspace.path) !== await homes.canonical(workspace.path)) {
          throw new ApiError(409, "invalid_session_parent", "无法验证父会话所属公司");
        }
        ancestors.push(parentId);
        parentId = typeof parent.parentID === "string" ? parent.parentID : undefined;
      }
      const meta = (await readSessionGroupState(config, workspace.id)).state.sessionMeta;
      const agentName = meta[sessionId]?.agentName ?? ancestors.map(id => meta[id]?.agentName).find(Boolean);
      const company = await homes.canonical(workspace.path);
      const projectDirectory = project.projectId ? project.executionDirectory : null;
      const rolePolicy = agentName ? await readRoleSkillPolicy(company, projectDirectory, agentName) : null;
      return { runtimeId: runtimeIdForConfig(config), sessionId, company,
        projectId: project.projectId, projectDirectory, ancestors,
        ...(agentName ? { agentName } : {}),
        ...(rolePolicy ? { roleSkills: { resident: rolePolicy.role.skills, adopted: rolePolicy.adopted } } : {}),
        ...(typeof session.title === "string" && session.title.trim() ? { label: session.title } : {}),
      };
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) unavailable ??= error;
    }
  }
  if (unavailable) throw new ApiError(503, "session_context_unavailable", "暂时无法验证会话所属项目");
  throw new ApiError(404, "session_not_found", "会话不存在或不属于已授权公司");
}
