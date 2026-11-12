import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

/**
 * Client for AIOPC's OPC service (services/opc). The desktop app starts it and
 * hands the renderer its local address and token; every call names the
 * workspace folder it is about.
 */
export type AiopcConnection = {
  status: "stopped" | "starting" | "ready" | "failed" | "unavailable";
  url: string;
  token: string;
  error: string;
  home: string;
};

export type AiopcCompany = { name: string; path: string };
/** A project belongs to a company workspace; company-root responses have no project id. */
export type AiopcProject = { name: string; path: string; id?: string; description?: string; company?: AiopcCompany;
  brief?: { context: string | null; brand: string | null; memory: string | null } };
export type AiopcProjectRecord = AiopcProject & { id: string; description: string; company: AiopcCompany };
export type AiopcProjectCatalog = { company: AiopcCompany; projects: AiopcProjectRecord[] };

export type SpaceKind = "image" | "video" | "audio" | "document";
export type SpaceSection = "brief" | "knowledge" | "assets" | "content" | "voices" | "other";
export type SpaceItem = {
  path: string;
  relative: string;
  name: string;
  kind: SpaceKind;
  section: SpaceSection;
  size: number;
  modified: number;
};

export type KnowledgeScope = "project" | "company" | "skills";
export type KnowledgeWriteScope = Exclude<KnowledgeScope, "skills">;

export type KnowledgeAsset = Omit<SpaceItem, "kind"> & {
  kind: SpaceKind | "skill";
  title: string;
  alias: string;
  aliases: string[];
  scope: string;
  description: string;
  related_paths: string[];
  relations: Array<{ path: string; name: string; relation: string; locator: string }>;
  extracted: boolean;
};
export type KnowledgeCatalog = {
  items: KnowledgeAsset[];
  truncated: boolean;
  warnings: string[];
  indexed_at: number | null;
};
export type KnowledgeSearchHit = {
  asset: KnowledgeAsset;
  snippet: string;
  locator: string;
  score: number;
  related: KnowledgeAsset[];
};
export type KnowledgeSearchResult = {
  query: string;
  mode: "hybrid" | "fts" | "empty";
  items: KnowledgeSearchHit[];
  warnings: string[];
};
export type KnowledgeIndexResult = { files: number; chunks: number; mode: string; warnings: string[] };

export type AiopcPlatform = {
  id: string;
  name: string;
  region: "cn" | "global";
  region_name: string;
  category: string;
  category_name: string;
  forms: string[];
  /** The AI can fill this platform's composer; otherwise it works on the site in the browser. */
  fills_composer: boolean;
  /** Ways in besides the built-in browser login every platform has. */
  methods: Array<Omit<AiopcEnhancement, "attached">>;
  login_url: string;
  color: string;
};
export type AiopcRouteField = { name: string; label: string; secret?: boolean };
/** An official route an account can add beyond the built-in browser. */
export type AiopcEnhancement = {
  route: string;
  name: string;
  does: string;
  fields: AiopcRouteField[];
  help: string;
  help_url: string;
  automatic?: boolean;
  attached: boolean;
};
export type AiopcService = {
  id: string;
  name: string;
  does: string;
  fields: AiopcRouteField[];
  help: string;
  help_url: string;
  configured: boolean;
  source: "keychain" | "env" | null;
};

export type AiopcAccount = {
  account_id: string;
  project?: string;
  environment?: string | null;
  platform: string;
  platform_name: string;
  name: string;
  handle: string;
  url: string;
  /** ready: AIOPC saw who is logged in; unverified: a platform it cannot check; needs_login: the login is gone. */
  status: "ready" | "unverified" | "needs_login";
  checked_at?: number | null;
  /** direct: an official API publishes after approval; compose: the AI fills the composer; browser: the AI works on the site. */
  publish: "direct" | "compose" | "browser";
  forms: string[];
  reads: string[];
  routes: Array<{ id: string; kind: "api" | "data" | "browser"; name: string }>;
  enhancements: AiopcEnhancement[];
  /** Shared data services for this platform (e.g. third-party X data). */
  services: AiopcService[];
  verified_at?: number | null;
};

/** Runtime state of one environment from the company resource pool. */
export type AiopcEnvironment = {
  provider: string;
  status: "running" | "starting" | "stopped" | "missing";
  id: string;
  live_view_url: string;
  detail: string;
  expires_at: string;
  running: boolean;
};
export type AiopcProvider = {
  id: string;
  name: string;
  kind: "local" | "cloud" | "manual";
  summary: string;
  help_url: string;
  persists_logins: boolean;
  configured: boolean;
  available: boolean;
  detail: string;
  fields: Array<{ name: string; label: string; secret: boolean; optional: boolean; placeholder: string }>;
};

export type ConnectResult =
  | { status: "login_opened"; platform: string; login_url?: string; message: string }
  | { status: "not_logged_in"; platform: string; message: string }
  /** GitHub: approve this one-time code on github.com/login/device (opened on the right). */
  | { status: "authorize"; platform: string; code: string; url: string; message: string }
  | { status: "connected"; account: AiopcAccount };

export class AiopcError extends Error {
  constructor(message: string, public readonly status?: number, public readonly data?: Record<string, unknown>) { super(message); }
}

const unavailable: AiopcConnection = { status: "unavailable", url: "", token: "", error: "只有 AIOPC 桌面应用能使用这个页面", home: "" };

async function readConnection(): Promise<AiopcConnection> {
  const bridge = typeof window === "undefined" ? undefined : window.__OPENWORK_ELECTRON__?.aiopc?.connection;
  return bridge ? await bridge() : unavailable;
}

/** The service connection, re-checked until the service is ready. */
export function useAiopcConnection() {
  return useQuery({
    queryKey: ["aiopc", "connection"],
    queryFn: readConnection,
    refetchInterval: (query) => (query.state.data?.status === "ready" || query.state.data?.status === "unavailable" ? false : 1500),
    staleTime: 30_000,
  });
}

export async function aiopcRequest<T>(
  connection: AiopcConnection,
  workspaceRoot: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  options: { params?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  if (connection.status !== "ready") throw new AiopcError(connection.error || "AIOPC 业务服务还没有就绪");
  const url = new URL(path, connection.url);
  url.searchParams.set("workspace", workspaceRoot);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new AiopcError("连不上 AIOPC 业务服务，请稍后重试");
  }
  const data = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new AiopcError(typeof data?.error === "string" ? data.error : `请求失败（${response.status}）`, response.status, data as Record<string, unknown> | undefined);
  return data as T;
}

/** Multipart uploads preserve each file's bytes and let the browser set its boundary. */
export async function importKnowledgeFiles(connection: AiopcConnection, workspaceRoot: string, files: File[], scope: KnowledgeWriteScope) {
  if (connection.status !== "ready") throw new AiopcError(connection.error || "AIOPC 业务服务还没有就绪");
  const url = new URL("/api/knowledge/import", connection.url);
  url.searchParams.set("workspace", workspaceRoot);
  const body = new FormData();
  body.append("scope", scope);
  for (const file of files) body.append("files", file);
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${connection.token}` }, body });
  } catch {
    throw new AiopcError("连不上 AIOPC 业务服务，请稍后重试");
  }
  const data = await response.json().catch(() => null) as { imported: number; items: KnowledgeAsset[]; error?: string } | null;
  if (!response.ok || !data) throw new AiopcError(data?.error || `请求失败（${response.status}）`);
  return data;
}

/** A knowledge base file's address for <img>/<video>, which cannot send headers. */
export function aiopcFileUrl(connection: AiopcConnection, workspaceRoot: string, path: string) {
  if (connection.status !== "ready") return "";
  const url = new URL("/api/file", connection.url);
  url.searchParams.set("workspace", workspaceRoot);
  url.searchParams.set("path", path);
  url.searchParams.set("token", connection.token);
  return url.toString();
}

/** Calls against one workspace, with the queries pages share. */
export function useAiopc(workspaceRoot: string, environmentId?: string) {
  const connectionQuery = useAiopcConnection();
  const connection = connectionQuery.data ?? null;
  const queryClient = useQueryClient();
  const ready = Boolean(connection?.status === "ready" && workspaceRoot);
  const request = useCallback(<T,>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string,
    options?: { params?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal }) => {
    if (!connection) throw new AiopcError("AIOPC 业务服务还没有就绪");
    return aiopcRequest<T>(connection, workspaceRoot, method, path, { ...options, params: { ...options?.params, ...(environmentId ? { environment: environmentId } : {}) } });
  }, [connection, workspaceRoot, environmentId]);
  const invalidate = useCallback((...key: string[]) => queryClient.invalidateQueries({ queryKey: ["aiopc", workspaceRoot, ...key] }),
    [queryClient, workspaceRoot]);
  return { connection, connectionQuery, ready, request, invalidate };
}

export function useAiopcProject(workspaceRoot: string) {
  const { ready, request } = useAiopc(workspaceRoot);
  return useQuery({
    queryKey: ["aiopc", workspaceRoot, "project"],
    enabled: ready,
    queryFn: () => request<AiopcProject>("GET", "/api/project"),
  });
}

/** Platforms do not change while the app runs. */
export function useAiopcPlatforms(workspaceRoot: string) {
  const { ready, request } = useAiopc(workspaceRoot);
  return useQuery({
    queryKey: ["aiopc", "platforms"],
    enabled: ready,
    staleTime: Infinity,
    queryFn: () => request<{ platforms: AiopcPlatform[] }>("GET", "/api/platforms").then((data) => data.platforms),
  });
}

/** The project's environment, polled while it is coming up. */
export function useAiopcEnvironment(workspaceRoot: string, environmentId?: string) {
  const { ready, request } = useAiopc(workspaceRoot, environmentId);
  return useQuery({
    queryKey: ["aiopc", workspaceRoot, "environment", environmentId ?? null],
    enabled: ready,
    refetchInterval: (query) => (query.state.data?.running ? 30_000 : 5_000),
    queryFn: () => request<AiopcEnvironment>("GET", "/api/environment"),
  });
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}


export type EnvironmentResource = {
  id: string; name: string; company: string; provider: string;
  boundProject: string | null; lastProject: string | null; bindingRevision: number;
  status: string; running: boolean; cdp_url: string; live_view_url: string; detail: string;
};
export type EnvironmentPool = { company: AiopcCompany; items: EnvironmentResource[]; providers: AiopcProvider[] };
export function useEnvironmentPool(companyRoot: string) {
  const { ready, request } = useAiopc(companyRoot);
  return useQuery({ queryKey: ["aiopc", companyRoot, "environments"], enabled: ready,
    queryFn: ({ signal }) => request<EnvironmentPool>("GET", "/api/environments", { signal }), refetchInterval: 5000, retry: false });
}
export function useProjectEnvironments(projectRoot: string) {
  const project = useAiopcProject(projectRoot);
  const companyRoot = project.data?.company?.path ?? "";
  const pool = useEnvironmentPool(companyRoot);
  return { project, pool, companyRoot, items: pool.data?.items.filter(item => item.boundProject === project.data?.path) ?? [] };
}
