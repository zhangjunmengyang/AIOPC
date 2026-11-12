/** @jsxImportSource react */
import { useQuery } from "@tanstack/react-query";
import {
  AudioLines,
  Building2,
  ExternalLink,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  List,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Upload,
  Video,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState, type ComponentType } from "react";

import { MarkdownBlock } from "@/components/markdown/markdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { openDesktopPath, revealDesktopItemInDir } from "@/app/lib/desktop";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";

import {
  aiopcFileUrl,
  formatBytes,
  importKnowledgeFiles,
  type AiopcConnection,
  type KnowledgeAsset,
  type KnowledgeCatalog,
  type KnowledgeIndexResult,
  type KnowledgeSearchHit,
  type KnowledgeSearchResult,
  type KnowledgeScope,
  type KnowledgeWriteScope,
  type SpaceKind,
  type SpaceSection,
  useAiopc,
  useAiopcProject,
} from "./aiopc-client";
import { AiopcUnavailable } from "./aiopc-status";

type Tab = "all" | "starred" | "generated";

const KIND_FILTERS: Array<{ kind: SpaceKind; label: string; icon: ComponentType<{ className?: string }> }> = [
  { kind: "document", label: "aiopc.space.kind_document", icon: FileText },
  { kind: "image", label: "aiopc.space.kind_image", icon: ImageIcon },
  { kind: "video", label: "aiopc.space.kind_video", icon: Video },
  { kind: "audio", label: "aiopc.space.kind_audio", icon: AudioLines },
];
const SECTIONS: SpaceSection[] = ["brief", "knowledge", "assets", "content", "voices", "other"];
const SCOPES: Array<{ id: KnowledgeScope; icon: ComponentType<{ className?: string }> }> = [
  { id: "project", icon: FolderOpen },
  { id: "company", icon: Building2 },
  { id: "skills", icon: Wrench },
];

function scopeLabel(scope: KnowledgeScope) {
  return t(`aiopc.space.scope_${scope}`);
}

const TEXT_SUFFIXES = [".md", ".markdown", ".rst", ".txt", ".csv", ".json"];
const STARRED_KEY = "aiopc.space.starred";
const VIEW_KEY = "aiopc.space.view";
const IMPORT_TYPES = ".md,.markdown,.rst,.txt,.csv,.json,.pdf,.docx,.xlsx,.pptx,.html,.htm,.png,.jpg,.jpeg,.webp,.gif,.svg,.mp4,.webm,.mov,.m4v,.mp3,.wav,.m4a,.ogg,.flac";

type PreviewSelection = { asset: KnowledgeAsset; hit?: KnowledgeSearchHit };

function assetName(asset: KnowledgeAsset) {
  return asset.kind === "skill" ? asset.title : asset.alias || asset.name;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function knowledgePrompt(asset: KnowledgeAsset, hit?: KnowledgeSearchHit) {
  const relatedPaths = [...new Set([
    ...asset.relations.map((relation) => relation.path),
    ...(hit?.related.map((item) => item.path) ?? []),
  ])];
  return [
    t("aiopc.space.ask_ai_prompt", { path: asset.scope === "company" || asset.scope === "skills" ? asset.path : asset.relative }),
    hit?.locator ? t("aiopc.space.prompt_locator", { locator: hit.locator }) : "",
    hit?.snippet ? t("aiopc.space.prompt_excerpt", { snippet: hit.snippet }) : "",
    relatedPaths.length ? t("aiopc.space.prompt_related", { paths: relatedPaths.join("\n") }) : "",
  ].filter(Boolean).join("\n\n");
}

function kindIcon(kind: KnowledgeAsset["kind"]) {
  return kind === "skill" ? Wrench : KIND_FILTERS.find((filter) => filter.kind === kind)?.icon ?? FileText;
}

function readStarred(): Set<string> {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(STARRED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function formatModified(seconds: number) {
  const date = new Date(seconds * 1000);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(currentLocale(), { month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

type SpacePageProps = { workspaceRoot: string; onAskAi: (prompt: string) => void };

export function SpacePage(props: SpacePageProps) {
  return <KnowledgeLibrary key={props.workspaceRoot} {...props} />;
}

function KnowledgeLibrary({ workspaceRoot, onAskAi }: SpacePageProps) {
  const { connection, ready, request, invalidate } = useAiopc(workspaceRoot);
  const projectQuery = useAiopcProject(workspaceRoot);
  const project = projectQuery.data?.id ? projectQuery.data : null;
  const scopes = project ? SCOPES : SCOPES.filter(({ id }) => id !== "project");
  const [chosenScope, setChosenScope] = useState<KnowledgeScope>();
  const scope = chosenScope ?? (project ? "project" : "company");
  const [kind, setKind] = useState<SpaceKind | "all">("all");
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">(() => (window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"));
  const [starred, setStarred] = useState(readStarred);
  const [opened, setOpened] = useState<PreviewSelection | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [actionWarnings, setActionWarnings] = useState<string[]>([]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 400);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const hasWorkspace = ready && projectQuery.isSuccess;
  const catalog = useQuery({
    queryKey: ["aiopc", workspaceRoot, "knowledge", "catalog", scope],
    enabled: hasWorkspace,
    queryFn: ({ signal }) => request<KnowledgeCatalog>("GET", "/api/knowledge", { params: { scope }, signal }),
    refetchInterval: 15_000,
    retry: false,
  });
  const items = catalog.data?.items ?? [];
  const searching = query.trim().length > 0;
  const debouncing = query.trim() !== debouncedQuery;
  const search = useQuery({
    queryKey: ["aiopc", workspaceRoot, "knowledge", "search", scope, kind, debouncedQuery],
    enabled: hasWorkspace && Boolean(debouncedQuery) && !debouncing,
    queryFn: ({ signal }) => request<KnowledgeSearchResult>("POST", "/api/knowledge/search", {
      body: { query: debouncedQuery, limit: 30, scope, ...(kind === "all" ? {} : { kind }) }, signal,
    }),
    retry: false,
    staleTime: 30_000,
  });

  const matchesFilter = (item: KnowledgeAsset) => {
    if (kind !== "all" && item.kind !== kind) return false;
    if (tab === "starred" && !starred.has(item.path)) return false;
    if (tab === "generated" && !item.relative.startsWith("assets/generated/")) return false;
    return true;
  };
  const visible = items.filter(matchesFilter);
  const hits = search.data?.items.filter((hit) => matchesFilter(hit.asset)) ?? [];
  const assets = useMemo(() => new Map([
    ...(catalog.data?.items ?? []),
    ...(search.data?.items.flatMap((hit) => [hit.asset, ...hit.related]) ?? []),
  ].map((item) => [item.path, item])), [catalog.data, search.data]);
  const warnings = [...new Set([
    ...(catalog.data?.warnings ?? []), ...actionWarnings,
    ...(searching && !debouncing ? search.data?.warnings ?? [] : []),
    ...(scope !== "skills" && searching && !debouncing && search.data?.mode === "fts" ? [t("aiopc.space.fts_notice")] : []),
  ])];

  if (!connection || connection.status !== "ready") return <AiopcUnavailable connection={connection} title={t("aiopc.space.title")} />;

  const toggleStar = (item: KnowledgeAsset) => {
    const next = new Set(starred);
    if (next.has(item.path)) next.delete(item.path);
    else next.add(item.path);
    setStarred(next);
    window.localStorage.setItem(STARRED_KEY, JSON.stringify([...next]));
  };
  const changeView = (next: "grid" | "list") => {
    setView(next);
    window.localStorage.setItem(VIEW_KEY, next);
  };
  const scopeName = projectQuery.data?.name ?? "";
  const createPrompts = [
    { label: t("aiopc.space.create_document"), icon: FileText, prompt: t("aiopc.space.create_document_prompt", { project: scopeName }) },
    { label: t("aiopc.space.create_image"), icon: ImageIcon, prompt: t("aiopc.space.create_image_prompt", { project: scopeName }) },
    { label: t("aiopc.space.create_bootstrap"), icon: Sparkles, prompt: t("aiopc.space.create_bootstrap_prompt", { project: scopeName }) },
  ];
  const selectScope = (next: KnowledgeScope) => {
    setChosenScope(next);
    setKind("all");
    setTab("all");
    setQuery("");
    setDebouncedQuery("");
    setOpened(null);
    setActionError("");
    setNotice("");
    setActionWarnings([]);
  };
  const updateIndex = async () => {
    setIndexing(true);
    setActionError("");
    setNotice("");
    setActionWarnings([]);
    try {
      const result = await request<KnowledgeIndexResult>("POST", "/api/knowledge/index", { body: { scope } });
      setNotice(t(result.mode === "fts" ? "aiopc.space.indexed_fts" : "aiopc.space.indexed", { files: result.files, chunks: result.chunks }));
      setActionWarnings(result.warnings);
      await invalidate("knowledge");
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setIndexing(false);
    }
  };
  const open = (asset: KnowledgeAsset, hit?: KnowledgeSearchHit) => setOpened({ asset, hit });
  const askAi = (asset: KnowledgeAsset, hit?: KnowledgeSearchHit) => {
    setOpened(null);
    onAskAi(knowledgePrompt(asset, hit));
  };

  const scopeNavigation = (compact: boolean) => (
    <nav aria-label={t("aiopc.space.scope_label")} className={compact ? "flex flex-wrap gap-1 md:hidden" : "flex flex-col gap-0.5"}>
      {scopes.map(({ id, icon: Icon }) => (
        <button key={id} type="button" aria-current={scope === id ? "true" : undefined} disabled={indexing}
          onClick={() => selectScope(id)}
          className={cn("flex h-8 items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors",
            scope === id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          {scopeLabel(id)}
        </button>
      ))}
    </nav>
  );

  return (
    <section data-aiopc-space aria-label={t("aiopc.space.title")} className="flex h-full min-h-0">
      <aside className="hidden w-44 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border/60 px-3 pb-6 pt-6 md:flex lg:w-52">
        {scopeNavigation(false)}
      </aside>

      <main aria-label={t("aiopc.space.list")} className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 pb-12 pt-6 sm:px-6">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight">{t("aiopc.space.title")}</h1>
              {scope !== "skills" && scopeName ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{scope === "project" ? scopeName : scopeLabel(scope)}</p> : null}
            </div>
            {scope !== "skills" ? <div className="flex shrink-0 items-center gap-1.5">
              {scope === "project" && project ? (
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="outline" size="sm"><Plus className="size-3.5" />{t("aiopc.space.create")}</Button>} />
                  <DropdownMenuContent align="end" className="w-56">
                    {createPrompts.map((item) => (
                      <DropdownMenuItem key={item.label} onClick={() => onAskAi(item.prompt)}>
                        <item.icon className="size-3.5" />
                        {item.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <Button variant="outline" size="sm" disabled={!hasWorkspace || indexing} onClick={() => setUploadOpen(true)}>
                <Upload className="size-3.5" />{t("aiopc.space.import")}
              </Button>
            </div> : null}
          </div>

          {scopeNavigation(true)}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-48 sm:max-w-80">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)}
                aria-label={t("aiopc.space.search")} placeholder={t("aiopc.space.search")} className="pl-8" />
            </div>
            {scope !== "skills" ? <select value={kind} onChange={(event) => setKind(event.currentTarget.value as SpaceKind | "all")}
              aria-label={t("aiopc.space.sections")} className="h-8 max-w-full rounded-lg border border-input bg-background px-2.5 text-sm">
              <option value="all">{t("aiopc.space.all")}</option>
              {KIND_FILTERS.map((option) => <option key={option.kind} value={option.kind}>{t(option.label)}</option>)}
            </select> : null}
          </div>

          {scope !== "skills" ? <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleGroup value={[tab]} onValueChange={(values) => { if (values[0]) setTab(values[0] as Tab); }} variant="segmented" spacing={0.5} size="xs" aria-label={t("aiopc.space.tabs")}>
              <ToggleGroupItem value="all">{t("aiopc.space.tab_all")}</ToggleGroupItem>
              <ToggleGroupItem value="starred">{t("aiopc.space.tab_starred")}</ToggleGroupItem>
              <ToggleGroupItem value="generated">{t("aiopc.space.tab_generated")}</ToggleGroupItem>
            </ToggleGroup>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" disabled={!hasWorkspace || indexing} onClick={() => void updateIndex()}>
                <RefreshCw className={cn("size-3.5", indexing && "animate-spin")} />
                {indexing ? t("aiopc.space.indexing") : t("aiopc.space.update_index")}
              </Button>
              {!searching ? <ToggleGroup value={[view]} onValueChange={(values) => { if (values[0]) changeView(values[0] as "grid" | "list"); }} variant="segmented" spacing={0.5} size="xs" aria-label={t("aiopc.space.view")}>
                <ToggleGroupItem value="grid" aria-label={t("aiopc.space.view_grid")}><LayoutGrid className="size-3.5" /></ToggleGroupItem>
                <ToggleGroupItem value="list" aria-label={t("aiopc.space.view_list")}><List className="size-3.5" /></ToggleGroupItem>
              </ToggleGroup> : null}
            </div>
          </div> : null}

          {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
          {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
          {warnings.length ? <div role="status" className="space-y-1 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {warnings.map((warning) => <p key={warning}>{warning}</p>)}
          </div> : null}
          {projectQuery.isError ? (
            <KnowledgeError error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />
          ) : !hasWorkspace ? (
            <p role="status" className="py-16 text-center text-sm text-muted-foreground">{t("aiopc.loading")}</p>
          ) : searching ? (
            debouncing || search.isPending ? <p role="status" className="py-16 text-center text-sm text-muted-foreground">{t("aiopc.space.searching")}</p>
              : search.isError ? <KnowledgeError error={search.error} onRetry={() => void search.refetch()} />
              : <div className="space-y-3" aria-live="polite">
                {hits.length === 0 ? <SpaceEmpty label={t("aiopc.space.no_matches")} />
                  : hits.map((hit) => <KnowledgeResult key={`${hit.asset.path}:${hit.locator}`}
                    hit={hit} connection={connection} workspaceRoot={workspaceRoot}
                    onOpen={open} onAskAi={() => askAi(hit.asset, hit)} />)}
              </div>
          ) : catalog.isError ? (
            <KnowledgeError error={catalog.error} onRetry={() => void catalog.refetch()} />
          ) : catalog.isPending ? (
            <p role="status" className="py-16 text-center text-sm text-muted-foreground">{t("aiopc.loading")}</p>
          ) : visible.length === 0 ? (
            <SpaceEmpty label={t(items.length ? "aiopc.space.no_matches" : scope === "skills" ? "aiopc.space.empty_skills" : "aiopc.space.empty")}
              hint={!items.length && scope !== "skills" ? t("aiopc.space.empty_hint") : undefined} />
          ) : (
            <div className="space-y-6">
              {SECTIONS.map((section) => {
                const group = visible.filter((item) => {
                  const category = item.section === "knowledge" && item.kind !== "document" && item.kind !== "skill"
                    ? "assets" : item.section;
                  return category === section;
                });
                if (!group.length) return null;
                return <section key={section} className="space-y-2.5">
                  {scope !== "skills" ? <h2 className="text-sm font-medium">{t(`aiopc.space.section_${section}`)}</h2> : null}
                  <div className={view === "grid" && scope !== "skills" ? "grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3" : "flex flex-col divide-y divide-border/60 rounded-xl border border-border/60"}>
                    {group.map((item) => (
                      <SpaceCard key={item.path} item={item} connection={connection} workspaceRoot={workspaceRoot}
                        related={item.relations.flatMap(({ path }) => assets.get(path) ?? [])}
                        view={scope === "skills" ? "list" : view} starred={starred.has(item.path)} onOpen={open} onToggleStar={() => toggleStar(item)} />
                    ))}
                  </div>
                </section>;
              })}
            </div>
          )}
          {catalog.data?.truncated ? <p className="text-xs text-muted-foreground">{t("aiopc.space.truncated")}</p> : null}
        </div>
      </main>

      {uploadOpen ? <KnowledgeUpload connection={connection} workspaceRoot={workspaceRoot} hasProject={Boolean(project)}
        onClose={() => setUploadOpen(false)}
        onImported={(destination, count) => {
          selectScope(destination);
          setUploadOpen(false);
          setNotice(t("aiopc.space.imported", { count }));
          void invalidate("knowledge");
        }} /> : null}
      {opened ? <SpacePreview key={opened.asset.path}
        selection={opened}
        assets={assets}
        connection={connection}
        workspaceRoot={workspaceRoot}
        readOnly={scope === "skills"}
        canPromote={scope === "project" && Boolean(project)}
        starred={starred.has(opened.asset.path)}
        onToggleStar={() => toggleStar(opened.asset)}
        onClose={() => setOpened(null)}
        onOpen={open}
        onAskAi={askAi}
        onSaved={(asset) => {
          setOpened((current) => current?.asset.path === asset.path ? { ...current, asset } : current);
          void invalidate("knowledge");
        }}
        onPromoted={() => {
          selectScope("company");
          setNotice(t("aiopc.space.promoted"));
          void invalidate("knowledge");
        }}
      /> : null}
    </section>
  );
}

function KnowledgeUpload(props: {
  connection: AiopcConnection;
  workspaceRoot: string;
  hasProject: boolean;
  onClose: () => void;
  onImported: (scope: KnowledgeWriteScope, count: number) => void;
}) {
  const [scope, setScope] = useState<KnowledgeWriteScope>(props.hasProject ? "project" : "company");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!files.length || busy) return;
    if (files.length > 20 || files.some((file) => file.size > 32 * 1024 * 1024)
      || files.reduce((total, file) => total + file.size, 0) > 128 * 1024 * 1024) {
      setError(t("aiopc.space.import_limit"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await importKnowledgeFiles(props.connection, props.workspaceRoot, files, scope);
      props.onImported(scope, result.imported);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const options: KnowledgeWriteScope[] = props.hasProject ? ["project", "company"] : ["company"];
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) props.onClose(); }}>
    <DialogContent showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>{t("aiopc.space.import")}</DialogTitle>
        <DialogDescription>{t("aiopc.space.import_limit")}</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <fieldset disabled={busy} className="flex flex-wrap gap-4">
          <legend className="mb-2 text-sm font-medium">{t("aiopc.space.upload_scope")}</legend>
          {options.map((option) => (
            <label key={option} className="flex items-center gap-2">
              <input type="radio" name="knowledge-scope" checked={scope === option} onChange={() => setScope(option)} />
              {scopeLabel(option)}
            </label>
          ))}
        </fieldset>
        <Input type="file" multiple accept={IMPORT_TYPES} aria-label={t("aiopc.space.files")} disabled={busy}
          onChange={(event) => { setFiles(Array.from(event.currentTarget.files ?? [])); setError(""); }} />
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={props.onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy || !files.length}>{t(busy ? "aiopc.space.importing" : "aiopc.space.upload_confirm")}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function KnowledgeError(props: { error: unknown; onRetry: () => void }) {
  return <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-destructive/20 px-4 py-3">
    <p className="text-sm text-destructive">{errorText(props.error)}</p>
    <Button variant="outline" size="sm" onClick={props.onRetry}>{t("aiopc.space.retry")}</Button>
  </div>;
}

function KnowledgeResult(props: {
  hit: KnowledgeSearchHit;
  connection: AiopcConnection;
  workspaceRoot: string;
  onOpen: (asset: KnowledgeAsset, hit?: KnowledgeSearchHit) => void;
  onAskAi: () => void;
}) {
  const { asset, snippet, locator, related } = props.hit;
  const media = [asset, ...related];
  return <article className="min-w-0 rounded-xl border border-border/60 px-4 py-3.5">
    <div className="flex items-start justify-between gap-3">
      <button type="button" className="min-w-0 text-left hover:underline" onClick={() => props.onOpen(asset, props.hit)}>
        <span className="block truncate text-sm font-medium">{assetName(asset)}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{asset.relative}{locator ? ` · ${locator}` : ""}</span>
      </button>
      <Button variant="ghost" size="sm" className="shrink-0" onClick={props.onAskAi}>
        <MessageSquarePlus className="size-3.5" />{t("aiopc.space.ask_ai")}
      </Button>
    </div>
    {snippet ? <p className="mt-3 line-clamp-5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/80">{snippet}</p> : null}
    <RelatedMedia items={media} connection={props.connection} workspaceRoot={props.workspaceRoot} onOpen={props.onOpen} />
  </article>;
}

function RelatedMedia(props: {
  items: KnowledgeAsset[];
  connection: AiopcConnection;
  workspaceRoot: string;
  onOpen: (asset: KnowledgeAsset) => void;
  compact?: boolean;
}) {
  const media = [...new Map(props.items.filter((item) => item.kind === "image" || item.kind === "video" || item.kind === "audio").map((item) => [item.path, item])).values()];
  if (!media.length) return null;
  return <div className={cn("flex flex-wrap gap-2", props.compact ? "px-3 pb-2.5" : "mt-3")} aria-label={t("aiopc.space.related_media")}>
    {media.map((item) => {
      const Icon = kindIcon(item.kind);
      return <button key={item.path} type="button" title={assetName(item)}
        aria-label={t("aiopc.space.preview_named", { name: assetName(item) })}
        className={cn("flex min-w-0 flex-col gap-1 text-left", props.compact ? "w-10" : "w-24")} onClick={() => props.onOpen(item)}>
        <span className={cn("flex w-full items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/30",
          props.compact ? "h-10" : "h-20")}>
          {item.kind === "image" ? <img src={aiopcFileUrl(props.connection, props.workspaceRoot, item.path)} alt="" loading="lazy"
            className="size-full object-cover" /> : <Icon className={cn("text-muted-foreground", props.compact ? "size-4" : "size-6")} />}
        </span>
        {!props.compact ? <span className="w-full truncate text-[11px] text-muted-foreground">{assetName(item)}</span> : null}
      </button>;
    })}
  </div>;
}

function SpaceEmpty({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-16 text-center">
      <FolderOpen className="size-8 text-muted-foreground" />
      <div className="text-sm font-medium">{label}</div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function SpaceCard(props: {
  item: KnowledgeAsset;
  related: KnowledgeAsset[];
  connection: AiopcConnection;
  workspaceRoot: string;
  view: "grid" | "list";
  starred: boolean;
  onOpen: (item: KnowledgeAsset) => void;
  onToggleStar: () => void;
}) {
  const { item } = props;
  const Icon = kindIcon(item.kind);
  const isGrid = props.view === "grid";
  const documentTile = isGrid && item.kind === "document";
  const src = isGrid && (item.kind === "image" || item.kind === "video") ? aiopcFileUrl(props.connection, props.workspaceRoot, item.path) : "";
  return (
    <div className={cn("group relative min-w-0", isGrid && "flex flex-col self-start overflow-hidden rounded-xl border border-border/60 bg-card transition-colors hover:border-foreground/20")}>
      <button type="button" onClick={() => props.onOpen(item)}
        className={cn("flex w-full min-w-0 text-left", isGrid && !documentTile ? "flex-col" : "items-center gap-2.5 px-3 py-2.5 hover:bg-muted/50")}>
        {isGrid && !documentTile ? <span className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-muted/40">
          {item.kind === "image" && src ? <img src={src} alt="" loading="lazy" className="size-full object-cover" />
            : item.kind === "video" && src ? <video src={src} preload="metadata" muted className="size-full object-cover" />
            : <Icon className="size-8 text-muted-foreground/70" />}
        </span> : <Icon className="size-4 shrink-0 text-muted-foreground" />}
        <span className={cn("min-w-0", documentTile ? "flex flex-1 flex-col gap-0.5" : isGrid ? "flex w-full flex-col gap-0.5 px-3 py-2.5" : "flex flex-1 items-center gap-2")}>
          <span className={cn("truncate font-medium", isGrid ? "text-[13px]" : "flex-1 text-sm")}>{assetName(item)}</span>
          {item.relative !== assetName(item) ? <span className={cn("truncate text-[11px] text-muted-foreground", !isGrid && "hidden max-w-64 md:block")}>{item.relative}</span> : null}
        </span>
        {!isGrid ? <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">{formatBytes(item.size)}</span> : null}
        {!isGrid ? <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{formatModified(item.modified)}</span> : null}
        {!isGrid && props.starred ? <Star className="size-3.5 shrink-0 fill-current text-amber-500" /> : null}
      </button>
      <RelatedMedia items={props.related} connection={props.connection} workspaceRoot={props.workspaceRoot} onOpen={props.onOpen} compact />
      {isGrid ? <button
        type="button"
        aria-label={props.starred ? t("aiopc.space.unstar") : t("aiopc.space.star")}
        onClick={props.onToggleStar}
        className={cn("absolute right-2 top-2 rounded-md bg-background/80 p-1 backdrop-blur transition-opacity",
          props.starred ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100")}>
        <Star className={cn("size-3.5", props.starred ? "fill-current text-amber-500" : "text-muted-foreground")} />
      </button> : null}
    </div>
  );
}

function SpacePreview(props: {
  selection: PreviewSelection;
  assets: ReadonlyMap<string, KnowledgeAsset>;
  connection: AiopcConnection;
  workspaceRoot: string;
  readOnly: boolean;
  canPromote: boolean;
  starred: boolean;
  onToggleStar: () => void;
  onClose: () => void;
  onOpen: (asset: KnowledgeAsset) => void;
  onAskAi: (item: KnowledgeAsset, hit?: KnowledgeSearchHit) => void;
  onSaved: (item: KnowledgeAsset) => void;
  onPromoted: () => void;
}) {
  const { asset: item, hit } = props.selection;
  const { request } = useAiopc(props.workspaceRoot);
  const src = aiopcFileUrl(props.connection, props.workspaceRoot, item.path);
  const isText = !props.readOnly && TEXT_SUFFIXES.some((suffix) => item.name.toLowerCase().endsWith(suffix));
  const textQuery = useQuery({
    queryKey: ["aiopc", props.workspaceRoot, "file", item.path, item.modified],
    enabled: Boolean(isText && src),
    queryFn: async ({ signal }) => {
      const response = await fetch(src, { signal });
      if (!response.ok) throw new Error(t("aiopc.space.preview_failed"));
      return await response.text();
    },
    retry: false,
  });
  const [aliases, setAliases] = useState(item.aliases.join(", "));
  const [description, setDescription] = useState(item.description);
  const [relatedPaths, setRelatedPaths] = useState(item.related_paths);
  const [relationQuery, setRelationQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [actionError, setActionError] = useState("");
  const run = (action: () => Promise<void>) => {
    setActionError("");
    void action().catch((error: unknown) => setActionError(errorText(error)));
  };
  const available = props.assets;
  const relationChoices = [...available.values()].filter((asset) => asset.path !== item.path && asset.scope === item.scope && (
    !relationQuery.trim() || `${assetName(asset)} ${asset.relative}`.toLocaleLowerCase().includes(relationQuery.trim().toLocaleLowerCase())
  )).sort((a, b) => Number(relatedPaths.includes(b.path)) - Number(relatedPaths.includes(a.path))).slice(0, 40);
  const nextAliases = [...new Set(aliases.split(/[,，、]/).map((value) => value.trim()).filter(Boolean))];
  const dirty = description !== item.description
    || JSON.stringify(nextAliases) !== JSON.stringify(item.aliases)
    || JSON.stringify([...relatedPaths].sort()) !== JSON.stringify([...item.related_paths].sort());
  const toggleRelation = (path: string) => {
    setSaved(false);
    setRelatedPaths((current) => current.includes(path) ? current.filter((value) => value !== path) : [...current, path]);
  };
  const save = async () => {
    if (!dirty || saving || promoting) return;
    setSaving(true); setSaved(false); setActionError("");
    try {
      const asset = await request<KnowledgeAsset>("PATCH", "/api/knowledge/asset", {
        body: { path: item.path, aliases: nextAliases, description, related_paths: relatedPaths },
      });
      setAliases(asset.aliases.join(", "));
      setDescription(asset.description);
      setRelatedPaths(asset.related_paths);
      props.onSaved(asset);
      setSaved(true);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const promote = async () => {
    if (promoting || saving) return;
    setPromoting(true);
    setActionError("");
    try {
      await request("POST", "/api/knowledge/promote", { body: { path: item.path } });
      props.onPromoted();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setPromoting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving && !promoting) props.onClose(); }}>
      <DialogContent showCloseButton={!saving && !promoting} className="flex max-h-[88vh] flex-col gap-4 lg:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{assetName(item)}</DialogTitle>
          <DialogDescription className="truncate">{item.relative} · {formatBytes(item.size)} · {formatModified(item.modified)}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto">
          {hit?.snippet ? <div className="rounded-lg bg-muted/40 px-4 py-3">
            {hit.locator ? <p className="mb-1 text-xs text-muted-foreground">{hit.locator}</p> : null}
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{hit.snippet}</p>
          </div> : null}
          {!props.readOnly ? <div className="overflow-auto rounded-lg bg-muted/30">
            {item.kind === "image" ? (
              <img src={src} alt={assetName(item)} className="mx-auto max-h-[42vh] object-contain" />
            ) : item.kind === "video" ? (
              <video src={src} controls className="mx-auto max-h-[42vh]" />
            ) : item.kind === "audio" ? (
              <audio src={src} controls className="m-6 w-[calc(100%-3rem)]" />
            ) : isText ? (
              <div className="max-h-[38vh] overflow-auto px-5 py-4 text-sm">
                {textQuery.isPending ? <p className="text-muted-foreground">{t("aiopc.loading")}</p>
                  : textQuery.isError ? <p role="alert" className="text-destructive">{t("aiopc.space.preview_failed")}</p>
                  : /\.(md|markdown)$/i.test(item.name) ? <MarkdownBlock text={textQuery.data ?? ""} />
                  : <pre className="whitespace-pre-wrap break-words font-mono text-xs">{textQuery.data}</pre>}
              </div>
            ) : (
              <p className="px-5 py-5 text-center text-xs text-muted-foreground">{t("aiopc.space.no_preview")}</p>
            )}
          </div> : null}
          {item.relations.length ? <div className="space-y-1.5">
            <h3 className="text-xs font-medium">{t("aiopc.space.sources_relations")}</h3>
            {item.relations.map((relation, index) => {
              const target = available.get(relation.path);
              const relationLabels: Record<string, string> = {
                extracted_from: "aiopc.space.relation_extracted_from", contains: "aiopc.space.relation_contains",
                references: "aiopc.space.relation_references", referenced_by: "aiopc.space.relation_referenced_by",
                related_to: "aiopc.space.relation_related_to", derived_from: "aiopc.space.relation_derived_from",
                source_of: "aiopc.space.relation_source_of",
              };
              return <div key={`${relation.path}:${relation.relation}:${index}`} className="flex items-center gap-2 text-xs">
                <span className="shrink-0 text-muted-foreground">{t(relationLabels[relation.relation] ?? "aiopc.space.relation_related_to")}</span>
                {target ? <button type="button" onClick={() => props.onOpen(target)} title={relation.path}
                  className="flex min-w-0 items-center gap-2 text-left hover:underline">
                  {target.kind === "image" ? <img src={aiopcFileUrl(props.connection, props.workspaceRoot, target.path)} alt="" className="size-10 rounded-md object-cover" /> : null}
                  <span className="truncate">{assetName(target)}</span>
                </button> : <span className="min-w-0 truncate" title={relation.path}>{relation.name}</span>}
                {relation.locator ? <span className="shrink-0 text-muted-foreground">{relation.locator}</span> : null}
              </div>;
            })}
          </div> : null}
          {!props.readOnly ? <fieldset disabled={saving || promoting} className="space-y-3 border-t border-border/60 pt-4">
            <label className="block space-y-1.5 text-xs font-medium">
              <span>{t("aiopc.space.search_aliases")}</span>
              <Input value={aliases} placeholder={t("aiopc.space.search_aliases_hint")} maxLength={6200}
                onChange={(event) => { setAliases(event.currentTarget.value); setSaved(false); }} />
            </label>
            <label className="block space-y-1.5 text-xs font-medium">
              <span>{t("aiopc.space.description")}</span>
              <textarea value={description} rows={3} maxLength={8000} placeholder={t("aiopc.space.description_hint")}
                className="w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm font-normal outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                onChange={(event) => { setDescription(event.currentTarget.value); setSaved(false); }} />
            </label>
            <details className="rounded-lg border border-border/60 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium">{t("aiopc.space.edit_relations", { count: relatedPaths.length })}</summary>
              <div className="mt-3 space-y-2">
                <p className="text-xs text-muted-foreground">{t("aiopc.space.relations_hint")}</p>
                <Input value={relationQuery} onChange={(event) => setRelationQuery(event.currentTarget.value)} aria-label={t("aiopc.space.find_relation")}
                  placeholder={t("aiopc.space.find_relation")} />
                <div className="max-h-36 space-y-1 overflow-y-auto">
                  {relationChoices.map((asset) => <label key={asset.path} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-xs hover:bg-muted/50">
                    <input type="checkbox" checked={relatedPaths.includes(asset.path)} onChange={() => toggleRelation(asset.path)} />
                    <span className="min-w-0 truncate" title={asset.relative}>{assetName(asset)}</span>
                  </label>)}
                  {!relationChoices.length ? <p className="py-2 text-xs text-muted-foreground">{t("aiopc.space.no_matches")}</p> : null}
                </div>
                {relationChoices.length === 40 ? <p className="text-xs text-muted-foreground">{t("aiopc.space.relations_filter_hint")}</p> : null}
                {relatedPaths.filter((path) => !available.has(path)).map((path) => <label key={path} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked onChange={() => toggleRelation(path)} /><span className="truncate">{path}</span>
                </label>)}
              </div>
            </details>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={() => void save()}>{saving ? t("aiopc.space.saving") : t("aiopc.save")}</Button>
              {saved ? <span role="status" className="text-xs text-muted-foreground">{t("aiopc.space.saved")}</span> : null}
            </div>
          </fieldset> : null}
        </div>
        {promoteOpen ? <div className="space-y-2 rounded-lg border border-border px-3 py-2.5">
          <p className="text-xs text-muted-foreground">{t("aiopc.space.promote_description")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={promoting} onClick={() => setPromoteOpen(false)}>{t("common.cancel")}</Button>
            <Button size="sm" disabled={promoting || saving || dirty} onClick={() => void promote()}>
              {t(promoting ? "aiopc.space.promote_pending" : "aiopc.space.promote_confirm")}
            </Button>
          </div>
        </div> : null}
        {actionError ? <p role="alert" className="text-xs text-destructive">{actionError}</p> : null}
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <Button size="sm" disabled={saving || promoting} onClick={() => props.onAskAi(item, hit)}><MessageSquarePlus className="size-3.5" />{t("aiopc.space.ask_ai")}</Button>
          {!props.readOnly ? <Button size="sm" variant="outline" disabled={saving || promoting} onClick={() => run(() => openDesktopPath(item.path))}><ExternalLink className="size-3.5" />{t("aiopc.space.open")}</Button> : null}
          {!props.readOnly ? <Button size="sm" variant="outline" disabled={saving || promoting} onClick={() => run(() => revealDesktopItemInDir(item.path))}><FolderOpen className="size-3.5" />{t("aiopc.space.reveal")}</Button> : null}
          {props.canPromote && !promoteOpen ? <Button size="sm" variant="outline" disabled={saving || dirty} onClick={() => setPromoteOpen(true)}>
            <Building2 className="size-3.5" />{t("aiopc.space.promote")}
          </Button> : null}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={props.onToggleStar}>
            <Star className={cn("size-3.5", props.starred && "fill-current text-amber-500")} />
            {props.starred ? t("aiopc.space.unstar") : t("aiopc.space.star")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
