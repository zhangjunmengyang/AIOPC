/** Project identity is stable across the sidebar, drafts and execution context. */
export function projectNameFromGroupId(groupId: string | null | undefined): string | null {
  if (!groupId?.startsWith("proj:")) return null;
  const name = groupId.slice(5);
  return !name || name === "." || name === ".." || /[/\\\u0000-\u001f\u007f]/.test(name) ? null : name;
}

/** Existing sessions keep their actual cwd; a sidebar assignment never relocates one. */
export function sessionExecutionDirectory(companyRoot: string, session?: { directory?: string; executionDirectory?: string } | null, draftGroupId?: string | null): string {
  if (session) return session.executionDirectory?.trim() || session.directory?.trim() || companyRoot;
  return executionDirectoryForGroup(companyRoot, draftGroupId);
}

export function projectGroupForDirectory(companyRoot: string, directory: string): string | null {
  const prefix = `${companyRoot.replace(/[/\\]+$/, "").replaceAll("\\", "/")}/projects/`;
  const normalized = directory.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized.startsWith(prefix)) return null;
  const group = `proj:${normalized.slice(prefix.length)}`;
  return isProjectSessionGroup(group) ? group : null;
}

export function projectGroupForSession(companyRoot: string, session?: { directory?: string; executionDirectory?: string } | null, draftGroupId?: string | null): string | null {
  if (session) return projectGroupForDirectory(session.directory?.trim() || companyRoot, sessionExecutionDirectory(companyRoot, session));
  return isProjectSessionGroup(draftGroupId) ? draftGroupId! : null;
}

type ProjectMetadata = { projectId?: string | null };
/** Metadata is the single project fact; legacy engine cwd is only a migration fallback. */
export function sessionProjectContext(companyRoot: string,
  session?: ({ directory?: string; executionDirectory?: string } & ProjectMetadata) | null,
  metadata?: ProjectMetadata, draftGroupId?: string | null,
): { projectId: string | null; executionDirectory: string } {
  const source = metadata && Object.hasOwn(metadata, "projectId") ? metadata
    : session && Object.hasOwn(session, "projectId") ? session : null;
  if (source) {
    const projectId = isProjectSessionGroup(source.projectId) ? source.projectId! : null;
    return { projectId, executionDirectory: executionDirectoryForGroup(session?.directory?.trim() || companyRoot, projectId) };
  }
  return { projectId: projectGroupForSession(companyRoot, session, draftGroupId), executionDirectory: sessionExecutionDirectory(companyRoot, session, draftGroupId) };
}

export function deriveProjectAssignments(assignments: Record<string, string>, metadata: Record<string, ProjectMetadata> = {}): Record<string, string> {
  const result = { ...assignments };
  for (const [sessionId, meta] of Object.entries(metadata)) {
    if (!Object.hasOwn(meta, "projectId")) continue;
    if (isProjectSessionGroup(meta.projectId)) result[sessionId] = meta.projectId!;
    else if (isProjectSessionGroup(result[sessionId])) delete result[sessionId];
  }
  return result;
}

export function isProjectSessionGroup(groupId: string | null | undefined): boolean {
  return projectNameFromGroupId(groupId) !== null;
}

/** The server validates real paths; this only constructs the requested project root. */
export function executionDirectoryForGroup(companyRoot: string, groupId: string | null | undefined): string {
  const name = projectNameFromGroupId(groupId);
  if (!name) return companyRoot;
  const separator = companyRoot.includes("\\") && !companyRoot.includes("/") ? "\\" : "/";
  return `${companyRoot.replace(/[/\\]+$/, "")}${separator}projects${separator}${name}`;
}

/** A created conversation keeps its project; company display folders remain editable. */
export function canAssignSessionGroup(projectId: string | null | undefined, groupId: string | null): boolean {
  if (isProjectSessionGroup(projectId)) return groupId === projectId;
  return !isProjectSessionGroup(groupId);
}

export function sessionProjectId(state: { assignments: Record<string, string>; sessionMeta?: Record<string, ProjectMetadata> } | undefined, sessionId: string): string | null {
  const meta = state?.sessionMeta?.[sessionId];
  if (meta && Object.hasOwn(meta, "projectId")) return meta.projectId ?? null;
  const legacy = state?.assignments[sessionId];
  return isProjectSessionGroup(legacy) ? legacy! : null;
}
