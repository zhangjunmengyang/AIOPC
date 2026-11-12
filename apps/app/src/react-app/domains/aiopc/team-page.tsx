/** @jsxImportSource react */
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, ChevronRight, FileText, MessageSquare, Users } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";

import { openDesktopUrl, openDesktopWorkspaceFile } from "@/app/lib/desktop";
import { unwrap } from "@/app/lib/opencode";
import { isOpencodeV2Client } from "@/app/lib/opencode-v2-adapter";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { Client } from "@/app/types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useTeamData } from "./team-client";
import {
  buildTeamOutputs, buildTeamRoster, latestTeamToolTitle, startOfTeamWeek, teamCardSkillNames,
  type TeamMember, type TeamOutput, type TeamProject, type TeamRole, type TeamSession,
  type TeamSessionSummary, type TeamStatus, type TeamTask,
} from "./team-data";
import { teamText } from "./team-text";

type Props = {
  endpoint: ResolvedWorkspaceEndpoint | null;
  client: Client | null;
  workspaceRoot: string;
  sessions: readonly TeamSessionSummary[];
  openSession: (sessionId: string) => void;
};

const dots: Record<TeamStatus, string> = {
  working: "bg-primary",
  waiting: "bg-warning",
  idle: "bg-muted-foreground/50",
  unknown: "border border-muted-foreground",
};
const itemClass = "flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring";

function Status({ status }: { status: TeamStatus }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden className={cn("size-2 rounded-full", dots[status])} />
      {teamText(status)}
    </span>
  );
}

function RoleAvatar({ role }: { role: TeamRole }) {
  const initials = Array.from(role.name.trim()).slice(0, 2).join("").toLocaleUpperCase();
  return <Avatar size="lg" aria-hidden><AvatarFallback>{initials}</AvatarFallback></Avatar>;
}

function projectLabel(id: string | null, projects: TeamProject[]) {
  return projects.find((project) => project.id === id)?.name ?? (id ? id.replace(/^proj:/, "") : teamText("company"));
}

function SessionLink({ session, projects, onOpen, toolTitle }: {
  session: TeamSession;
  projects: TeamProject[];
  onOpen: Props["openSession"];
  toolTitle?: string | null;
}) {
  const title = session.title.trim() || teamText("openSession");
  return (
    <button type="button" className={cn("w-full", itemClass)} onClick={() => onOpen(session.id)}>
      <MessageSquare aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium" title={toolTitle || title}>{toolTitle || title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {projectLabel(session.projectId, projects)}
          {toolTitle && session.title ? ` · ${session.title}` : ""}
        </span>
      </span>
      <ArrowUpRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function CurrentWork({ member, client, endpoint, projects, openSession }: {
  member: TeamMember;
  client: Props["client"];
  endpoint: Props["endpoint"];
  projects: TeamProject[];
  openSession: Props["openSession"];
}) {
  const sessionId = member.currentSession?.id;
  const tool = useQuery({
    queryKey: ["aiopc", "team-current-tool", endpoint?.baseUrl, endpoint?.workspaceId,
      client && isOpencodeV2Client(client) ? "v2" : "v1", sessionId],
    enabled: Boolean(client && sessionId),
    queryFn: async ({ signal }) => latestTeamToolTitle(unwrap(await client!.session.messages({ sessionID: sessionId!, limit: 24 }, { signal }))),
    refetchInterval: 5_000,
  });
  return member.currentSession
    ? <SessionLink session={member.currentSession} projects={projects} onOpen={openSession} toolTitle={tool.data} />
    : <p className="text-sm text-muted-foreground">{teamText(member.status === "unknown" ? "unknown" : "noCurrent")}</p>;
}

function SkillTags({ items }: { items: string[] }) {
  return items.length ? (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((skill) => <li key={skill} className="max-w-full break-words rounded-md bg-muted px-2 py-0.5 text-xs">{skill}</li>)}
    </ul>
  ) : <p className="text-sm text-muted-foreground">{teamText("noSkills")}</p>;
}

function OutputList({ entries, loading = false }: { entries: TeamOutput[]; loading?: boolean }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">{teamText(loading ? "outputsLoading" : "noOutputs")}</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {entries.map((entry) => {
        const project = entry.project.name || teamText("company");
        const date = new Date(entry.at).toLocaleDateString(currentLocale(), { month: "short", day: "numeric" });
        if (entry.kind === "publish") {
          const status = teamText(entry.record.status === "published" ? "published" : "composerFilled");
          const title = `${entry.record.platform} · ${status}`;
          const url = entry.record.status === "published" && entry.record.url?.startsWith("https://") ? entry.record.url : null;
          return (
            <li key={entry.id} className="min-w-0 py-2">
              {url ? (
                <button type="button" onClick={() => void openDesktopUrl(url).catch(() => toast.error(teamText("openFileError")))}
                  className={cn("w-full", itemClass)}>
                  <span className="min-w-0 flex-1 break-words">{title}</span>
                  <ArrowUpRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </button>
              ) : <p className="break-words text-sm">{title}</p>}
              <p className="break-words text-xs text-muted-foreground">{project} · {date}</p>
            </li>
          );
        }
        return (
          <li key={entry.id} className="min-w-0 py-2">
            <p className="break-words text-sm font-medium">{entry.task.title}</p>
            <p className="break-words text-xs text-muted-foreground">{project} · {date}</p>
            <ul className="mt-1">
              {entry.task.deliverables.map((deliverable, index) => (
                <li key={`${deliverable.path}:${index}`}>
                  <button type="button" className={cn("w-full", itemClass)}
                    onClick={() => void openDesktopWorkspaceFile(entry.project.directory, deliverable.path)
                      .catch(() => toast.error(teamText("openFileError")))}>
                    <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate" title={deliverable.path}>{deliverable.label || deliverable.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

type MemberProps = Pick<Props, "client" | "endpoint" | "openSession"> & {
  member: TeamMember;
  projects: TeamProject[];
  outputs: TeamOutput[];
  loadingOutputs: boolean;
};

function MemberCard({ member, projects, outputs, loadingOutputs, ...work }: MemberProps) {
  const skills = teamCardSkillNames(member, projects);
  return (
    <article className="min-w-0 rounded-xl border bg-card p-4 text-card-foreground">
      <div className="flex items-center gap-3">
        <RoleAvatar role={member.role} />
        <h2 className="min-w-0 flex-1">
          <Link className="group flex min-h-9 items-center gap-1 rounded font-medium focus-visible:outline-2 focus-visible:outline-ring"
            to={`?role=${encodeURIComponent(member.role.id)}`}>
            <span className="truncate group-hover:underline">{member.role.name}</span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </Link>
        </h2>
        <Status status={member.status} />
      </div>
      {member.role.description ? <p className="mt-2 line-clamp-2 break-words text-sm text-muted-foreground">{member.role.description}</p> : null}
      <div className="mt-4 space-y-4 border-t pt-3">
        <div className="space-y-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{teamText("current")}</h3>
          <CurrentWork member={member} projects={projects} {...work} />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{teamText("skills")}</h3>
          <SkillTags items={skills.slice(0, 5)} />
          {skills.length > 5 ? <p className="text-xs text-muted-foreground">+{skills.length - 5}</p> : null}
        </div>
        <div className="space-y-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{teamText("outputs")}</h3>
          <OutputList entries={outputs.slice(0, 2)} loading={loadingOutputs} />
        </div>
      </div>
    </article>
  );
}

function MemberDetail({ member, projects, outputs, loadingOutputs, manager, tasks, ...work }: MemberProps & {
  manager?: TeamRole;
  tasks: Array<TeamTask & { project: TeamProject }>;
}) {
  return (
    <>
      <Link to="?" className={cn("w-fit", itemClass)}><ArrowLeft aria-hidden className="size-4" />{teamText("back")}</Link>
      <div className="mt-3 flex items-center gap-3">
        <RoleAvatar role={member.role} />
        <h1 className="min-w-0 flex-1 break-words text-2xl font-semibold">{member.role.name}</h1>
        <Status status={member.status} />
      </div>
      {member.role.description ? <p className="mt-3 max-w-2xl break-words text-sm text-muted-foreground">{member.role.description}</p> : null}
      {member.role.reportsTo ? (
        <p className="mt-2 text-sm text-muted-foreground">{teamText("reportsTo")} {manager?.name || member.role.reportsTo}</p>
      ) : null}
      <div className="mt-6 grid gap-5 @min-[740px]/team:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">{teamText("current")}</h2>
            <CurrentWork member={member} projects={projects} {...work} />
          </section>
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">{teamText("recentSessions")}</h2>
            {member.sessions.length ? (
              <ul className="divide-y divide-border">
                {member.sessions.slice(0, 8).map((session) => (
                  <li key={session.id}><SessionLink session={session} projects={projects} onOpen={work.openSession} /></li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">{teamText("noSessions")}</p>}
          </section>
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">{teamText("tasks")}</h2>
            {tasks.length ? (
              <ul className="divide-y divide-border">
                {tasks.map((task) => (
                  <li key={`${task.project.id}:${task.id}`} className="flex min-w-0 justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0 break-words">{task.title}<span className="block text-xs text-muted-foreground">{task.project.name}</span></span>
                    <span className="shrink-0 text-xs text-muted-foreground">{teamText(task.status)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">{teamText("noTasks")}</p>}
          </section>
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">{teamText("outputs")}</h2>
            <OutputList entries={outputs} loading={loadingOutputs} />
          </section>
        </div>
        <div className="min-w-0 space-y-4 rounded-xl border bg-card p-4 text-card-foreground self-start">
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">{teamText("resident")}</h2>
            <SkillTags items={member.role.skills} />
          </section>
          <section className="space-y-2 border-t pt-4">
            <h2 className="text-sm font-semibold">{teamText("projectSkills")}</h2>
            {projects.some((project) => project.skills.length) ? projects.filter((project) => project.skills.length).map((project) => (
              <div key={project.id} className="space-y-1">
                <p className="break-words text-xs text-muted-foreground">{project.name}</p>
                <SkillTags items={project.skills} />
              </div>
            )) : <p className="text-sm text-muted-foreground">{teamText("noSkills")}</p>}
          </section>
        </div>
      </div>
    </>
  );
}

export function TeamPage({ endpoint, client, workspaceRoot, sessions, openSession }: Props) {
  const [search] = useSearchParams();
  const roleId = search.get("role");
  const data = useTeamData(endpoint, client, workspaceRoot);
  const roles = data.roles.data?.items ?? [];
  const metadata = data.groups.data?.state.sessionMeta ?? {};
  const roster = buildTeamRoster(roles, metadata, sessions, {
    active: data.active.isError || data.groups.isError ? null : data.active.data ?? null,
    waiting: data.waiting.isError || data.groups.isError ? null : data.waiting.data ?? null,
  });
  const outputs = buildTeamOutputs(data.outputs, metadata, new Set(roles.map((role) => role.id)), startOfTeamWeek(new Date()));
  const selected = roster.find((member) => member.role.id === roleId);
  const memberProps = (member: TeamMember): MemberProps => ({
    member, client, endpoint, projects: data.projects, outputs: outputs.byRole.get(member.role.id) ?? [],
    openSession, loadingOutputs: data.outputsLoading,
  });

  return (
    <section className="@container/team h-full min-h-0 min-w-0 overflow-y-auto" aria-label={teamText("title")}>
      <div className="mx-auto max-w-5xl px-4 py-5 sm:px-7 sm:py-7">
        {data.roles.isError ? (
          <div className="flex flex-wrap items-center gap-3" role="alert">
            <p className="text-sm text-muted-foreground">{teamText("loadError")}</p>
            <Button size="sm" variant="outline" onClick={() => void data.roles.refetch()}>{t("aiopc.refresh")}</Button>
          </div>
        ) : data.roles.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("aiopc.loading")}</p>
          : selected ? (
            <MemberDetail {...memberProps(selected)}
              manager={roles.find((role) => role.id === selected.role.reportsTo)}
              tasks={data.outputs.flatMap((scope) => {
                const project = data.projects.find((project) => project.id === scope.id);
                return project ? scope.tasks.filter((task) => task.assignee === selected.role.id).map((task) => ({ ...task, project })) : [];
              }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))} />
          ) : (
            <>
              {roleId ? <p className="mb-3 text-sm text-muted-foreground">{teamText("roleMissing")}</p> : null}
              <h1 className="mb-4 flex items-center gap-2 text-xl font-semibold">
                {teamText("roles")} <span className="text-sm font-normal text-muted-foreground">{roster.length}</span>
              </h1>
              {roster.length ? (
                <div className="grid grid-cols-1 items-start gap-3 @min-[680px]/team:grid-cols-2">
                  {roster.map((member) => <MemberCard key={member.role.id} {...memberProps(member)} />)}
                </div>
              ) : (
                <div className="flex min-h-28 items-center gap-3 rounded-xl border px-4 text-sm text-muted-foreground">
                  <Users aria-hidden className="size-5" />{teamText("noRoles")}
                </div>
              )}
              {outputs.unattributed.length ? (
                <section className="mt-6 space-y-2">
                  <h2 className="text-sm font-semibold">{teamText("unattributed")}</h2>
                  <OutputList entries={outputs.unattributed} />
                </section>
              ) : null}
            </>
          )}
        {data.outputsIncomplete ? <p role="status" className="mt-5 text-xs text-muted-foreground">{teamText("outputsIncomplete")}</p> : null}
      </div>
    </section>
  );
}
