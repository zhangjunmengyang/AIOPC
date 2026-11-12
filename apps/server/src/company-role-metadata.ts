import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isMap, parseDocument, type Document } from "yaml";
import { ApiError } from "./errors.js";

export type CompanyRoleDocument = {
  id: string;
  path: string;
  mode: number;
  metadata: Document;
  content: string;
  body: string;
  newline: string;
};

const FRONTMATTER = /^---(?:\r?\n)([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;

const ROLE_ID = /^[^./\\\u0000-\u0020\u007f][^/\\\u0000-\u001f\u007f]{0,127}$/u;

async function safeRoleDirectories(company: string): Promise<string[]> {
  const directories: string[] = [];
  for (const name of ["agent", "agents"]) {
    const path = join(company, ".opencode", name);
    if (await realpath(path).catch(() => null) === path) directories.push(path);
  }
  return directories;
}

async function readRoleFile(path: string): Promise<{ content: string; mode: number } | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ELOOP") return null;
      throw error;
    });
  if (!file) return null;
  try {
    const stat = await file.stat();
    return stat.isFile() ? { content: await file.readFile("utf8"), mode: stat.mode & 0o777 } : null;
  } finally {
    await file.close();
  }
}

async function readDocument(directories: string[], id: string): Promise<CompanyRoleDocument | null> {
  for (const directory of directories) {
    const path = join(directory, id + ".md");
    const file = await readRoleFile(path);
    if (!file) continue;

    const match = file.content.match(FRONTMATTER);
    const header = match?.index === 0 ? match : null;
    const metadata = parseDocument(header?.[1] ?? "");
    if (metadata.errors.length > 0 || (metadata.contents !== null && !isMap(metadata.contents))) return null;
    if (["disable", "disabled", "hidden"].some((key) => metadata.get(key) === true)) return null;

    return {
      ...file,
      id,
      path,
      metadata,
      body: header ? file.content.slice(header[0].length) : file.content,
      newline: file.content.includes("\r\n") ? "\r\n" : "\n",
    };
  }
  return null;
}

/** Read a company-only OpenCode role by its native filename ID. */
export async function readCompanyRoleDocument(companyRoot: string, id: string): Promise<CompanyRoleDocument | null> {
  if (!ROLE_ID.test(id)) return null;
  return readDocument(await safeRoleDirectories(await realpath(companyRoot)), id);
}

export async function listCompanyRoleDocuments(companyRoot: string): Promise<CompanyRoleDocument[]> {
  const directories = await safeRoleDirectories(await realpath(companyRoot));
  const entries = await Promise.all(directories.map((directory) => readdir(directory, { withFileTypes: true }).catch(() => [])));
  const ids = new Set(entries.flat()
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -3))
    .filter((id) => ROLE_ID.test(id)));
  const roles = await Promise.all([...ids].sort().map((id) => readDocument(directories, id).catch(() => null)));
  return roles.filter((role) => role !== null);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readCompanyRoleMetadata(role: CompanyRoleDocument) {
  const manager = text(role.metadata.getIn(["metadata", "aiopc", "reportsTo"]));
  return {
    id: role.id,
    name: text(role.metadata.getIn(["metadata", "aiopc", "name"])) ?? role.id,
    description: text(role.metadata.get("description")),
    reportsTo: manager && ROLE_ID.test(manager) && manager !== role.id ? manager : null,
  };
}

export function setCompanyRoleReportsTo(role: CompanyRoleDocument, reportsTo: string | null): string {
  const metadata = role.metadata.get("metadata", true);
  const aiopc = isMap(metadata) ? metadata.get("aiopc", true) : undefined;
  if ((metadata !== undefined && !isMap(metadata)) || (aiopc !== undefined && !isMap(aiopc))) {
    throw new ApiError(409, "company_role_metadata_invalid", "角色文件的 metadata.aiopc 必须是对象");
  }
  role.metadata.setIn(["metadata", "aiopc", "reportsTo"], reportsTo);
  const header = "---\n" + role.metadata.toString() + "---\n";
  return header.replaceAll("\n", role.newline) + role.body;
}

export async function ensureCompanyRoleDocumentUnchanged(role: CompanyRoleDocument): Promise<void> {
  const info = await lstat(role.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info?.isFile() || await realpath(role.path).catch(() => null) !== role.path) {
    throw new ApiError(404, "company_role_not_found", "公司角色不存在");
  }
  if ((await readRoleFile(role.path))?.content !== role.content) {
    throw new ApiError(409, "company_role_changed", "角色文件已修改，请刷新后重试");
  }
}
