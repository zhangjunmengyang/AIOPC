import { ProjectEnvironments } from "./environment-pool";
/** @jsxImportSource react */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { FileText, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MarkdownBlock } from "@/components/markdown/markdown";
import { t } from "@/i18n";
import { openDesktopPath } from "@/app/lib/desktop";
import { AiopcUnavailable } from "./aiopc-status";
import { useAiopc, useAiopcProject, type AiopcProjectCatalog, type AiopcProjectRecord, type SpaceItem } from "./aiopc-client";

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function stageAndGoal(context?: string | null) {
  return context?.match(/^##\s+(?:当前阶段与目标|Stage and goals)\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1]?.trim() ?? "";
}
function starredFiles(items: SpaceItem[]) {
  try { const starred: unknown = JSON.parse(localStorage.getItem("aiopc.space.starred") ?? "[]"); return Array.isArray(starred) ? items.filter(item => starred.includes(item.path)) : []; } catch { return []; }
}

export function ProjectsPage(props: { companyRoot: string; projectName?: string; onOpenProject: (name: string) => void;
  onCreated: (project: AiopcProjectRecord) => Promise<void>; onStartConversation: (project: AiopcProjectRecord) => void;
  onOpenKnowledge: (project: AiopcProjectRecord) => void }) {
  const { connection, ready, request, invalidate } = useAiopc(props.companyRoot);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const [createdProject, setCreatedProject] = useState<AiopcProjectRecord | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const catalog = useQuery({ queryKey: ["aiopc", props.companyRoot, "projects"], enabled: ready,
    queryFn: ({ signal }) => request<AiopcProjectCatalog>("GET", "/api/projects", { signal }), retry: false });
  useEffect(() => { setCreateOpen(false); setCreatedProject(null); setError(""); }, [props.companyRoot]);
  const selected = catalog.data?.projects.find(project => project.name === props.projectName);
  if (!connection || connection.status !== "ready") return <AiopcUnavailable connection={connection} title={t("aiopc.projects.title")} />;
  const create = async () => {
    setBusy(true); setError("");
    try {
      const project = createdProject ?? await request<AiopcProjectRecord>("POST", "/api/projects", { body: { name: name.trim(), description: description.trim() } });
      setCreatedProject(project);
      await props.onCreated(project);
      await invalidate("projects");
      setCreateOpen(false); props.onOpenProject(project.name);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <section className="h-full overflow-y-auto px-6 py-7 sm:px-10" aria-label={t("aiopc.projects.title")}>
    <div className="mx-auto max-w-4xl space-y-7">
      <header className="flex items-center justify-between gap-4">
        <div><p className="mb-1 text-xs text-muted-foreground">{catalog.data?.company.name}</p><h1 className="text-xl font-semibold tracking-tight">{selected?.name ?? t("aiopc.projects.title")}</h1></div>
        <Button variant="outline" size="sm" onClick={() => { setName(""); setDescription(""); setError(""); setCreatedProject(null); setCreateOpen(true); }}><Plus className="size-3.5" />{t("aiopc.projects.new")}</Button>
      </header>
      {catalog.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("aiopc.projects.loading")}</p> : catalog.isError ? <div role="alert" className="space-y-2 text-sm"><p>{errorMessage(catalog.error)}</p><Button variant="outline" onClick={() => void catalog.refetch()}>{t("aiopc.projects.retry")}</Button></div>
        : props.projectName ? selected ? <ProjectOverview project={selected} onStart={() => props.onStartConversation(selected)} onKnowledge={() => props.onOpenKnowledge(selected)} /> : <p role="alert" className="text-sm text-muted-foreground">{t("aiopc.projects.missing")}</p>
          : catalog.data?.projects.length ? <div className="grid gap-3 sm:grid-cols-2">{catalog.data.projects.map(project => <button key={project.id} onClick={() => props.onOpenProject(project.name)} className="rounded-xl border border-border/70 p-5 text-left transition-colors hover:bg-muted/40"><h2 className="font-medium">{project.name}</h2><p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{project.description || t("aiopc.projects.no_description")}</p></button>)}</div> : <p className="text-sm text-muted-foreground">{t("aiopc.projects.empty")}</p>}
    </div>
    <Dialog open={createOpen} onOpenChange={open => { if (!busy) setCreateOpen(open); }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{t("aiopc.projects.new")}</DialogTitle><DialogDescription>{t("aiopc.projects.create_hint")}</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); void create(); }}>
        <label className="block space-y-1.5 text-sm"><span>{t("aiopc.projects.name")}</span><Input name="projectName" value={name} maxLength={120} disabled={busy || Boolean(createdProject)} onChange={event => setName(event.target.value)} autoFocus /></label>
        <label className="block space-y-1.5 text-sm"><span>{t("aiopc.projects.description")}</span><textarea name="projectDescription" value={description} maxLength={2000} rows={3} disabled={busy || Boolean(createdProject)} onChange={event => setDescription(event.target.value)} className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30" /></label>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end"><Button type="submit" disabled={busy || !name.trim()}>{busy ? t("aiopc.projects.creating") : createdProject ? t("aiopc.projects.retry") : t("aiopc.projects.create")}</Button></div>
      </form>
    </DialogContent></Dialog>
  </section>;
}

function ProjectOverview(props: { project: AiopcProjectRecord; onStart: () => void; onKnowledge: () => void }) {
  const { ready, request } = useAiopc(props.project.path);
  const project = useAiopcProject(props.project.path);
  const files = useQuery({ queryKey: ["aiopc", props.project.path, "space"], enabled: ready,
    queryFn: ({ signal }) => request<{ items: SpaceItem[]; truncated: boolean }>("GET", "/api/space", { signal }), retry: false });
  const recent = (files.data?.items ?? []).filter(item => item.section === "content").sort((a, b) => b.modified - a.modified).slice(0, 6);
  const starred = starredFiles(files.data?.items ?? []);
  const [fileError, setFileError] = useState("");
  const openFile = (file: SpaceItem) => { void openDesktopPath(file.path).catch(error => setFileError(errorMessage(error))); };
  const fileList = (items: SpaceItem[]) => <div className="divide-y divide-border/50">{items.map(file => <button key={file.path} onClick={() => openFile(file)} className="flex w-full items-center gap-3 py-3 text-left text-sm hover:text-foreground/70"><FileText className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{file.relative}</span></button>)}</div>;
  return <div className="space-y-6">
    <p className="text-sm leading-relaxed text-muted-foreground">{props.project.description || t("aiopc.projects.no_description")}</p>
    <div className="flex flex-wrap gap-2"><Button size="sm" onClick={props.onStart}>{t("aiopc.projects.start")}</Button><Button size="sm" variant="outline" onClick={props.onKnowledge}>{t("aiopc.projects.knowledge")}</Button></div>
    <section className="rounded-xl border border-border/70 p-5"><h2 className="mb-3 text-sm font-medium">{t("aiopc.projects.stage")}</h2>{project.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("aiopc.projects.loading")}</p> : project.isError ? <p role="alert" className="text-sm text-destructive">{errorMessage(project.error)}</p> : stageAndGoal(project.data?.brief?.context) ? <MarkdownBlock text={stageAndGoal(project.data?.brief?.context)} /> : <p className="text-sm text-muted-foreground">{t("aiopc.projects.stage_empty")}</p>}<p className="mt-3 text-xs text-muted-foreground">CONTEXT.md</p></section>
    {starred.length ? <section><h2 className="text-sm font-medium">{t("aiopc.projects.pinned")}</h2>{fileList(starred)}</section> : null}
    <section><h2 className="text-sm font-medium">{t("aiopc.projects.deliverables")}</h2>{files.isPending ? <p role="status" className="mt-3 text-sm text-muted-foreground">{t("aiopc.projects.loading")}</p> : files.isError ? <p role="alert" className="mt-3 text-sm text-destructive">{errorMessage(files.error)}</p> : recent.length ? fileList(recent) : <p className="mt-3 text-sm text-muted-foreground">{t("aiopc.projects.deliverables_empty")}</p>}</section>
    <ProjectEnvironments key={props.project.path} companyRoot={props.project.company.path} projectRoot={props.project.path} />
    {fileError ? <p role="alert" className="text-sm text-destructive">{fileError}</p> : null}
  </div>;
}
