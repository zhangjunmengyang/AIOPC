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

/** The current workspace: in AIOPC a workspace is a project. */
export type AiopcProject = { name: string; path: string };

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

export type AiopcPlatform = {
  id: string;
  name: string;
  region: "cn" | "global";
  region_name: string;
  category: string;
  category_name: string;
  forms: string[];
  status: "available" | "planned";
  login_url: string;
  color: string;
};
export type AiopcAccount = {
  account_id: string;
  platform: string;
  platform_name: string;
  name: string;
  handle: string;
  url: string;
  status: "ready" | "needs_login";
  forms: string[];
  reads: string[];
  verified_at?: number | null;
};

export type ConnectResult =
  | { status: "login_opened"; platform: string; login_url?: string; message: string }
  | { status: "not_logged_in"; platform: string; message: string }
  | { status: "connected"; account: AiopcAccount };

export class AiopcError extends Error {}

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
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: { params?: Record<string, string | undefined>; body?: unknown } = {},
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
    });
  } catch {
    throw new AiopcError("连不上 AIOPC 业务服务，请稍后重试");
  }
  const data = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new AiopcError(data?.error || `请求失败（${response.status}）`);
  return data as T;
}

/** A Space file's address for <img>/<video>, which cannot send headers. */
export function aiopcFileUrl(connection: AiopcConnection, workspaceRoot: string, path: string) {
  if (connection.status !== "ready") return "";
  const url = new URL("/api/file", connection.url);
  url.searchParams.set("workspace", workspaceRoot);
  url.searchParams.set("path", path);
  url.searchParams.set("token", connection.token);
  return url.toString();
}

/** Calls against one workspace, with the queries pages share. */
export function useAiopc(workspaceRoot: string) {
  const connectionQuery = useAiopcConnection();
  const connection = connectionQuery.data ?? null;
  const queryClient = useQueryClient();
  const ready = Boolean(connection?.status === "ready" && workspaceRoot);
  const request = useCallback(<T,>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string,
    options?: { params?: Record<string, string | undefined>; body?: unknown }) => {
    if (!connection) throw new AiopcError("AIOPC 业务服务还没有就绪");
    return aiopcRequest<T>(connection, workspaceRoot, method, path, options);
  }, [connection, workspaceRoot]);
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

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
