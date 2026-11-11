/** @jsxImportSource react */
import { useQuery } from "@tanstack/react-query";
import {
  AudioLines,
  BookOpen,
  ExternalLink,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  List,
  MessageSquarePlus,
  Package,
  PenLine,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Video,
} from "lucide-react";
import { useEffect, useMemo, useState, type ComponentType } from "react";

import { MarkdownBlock } from "@/components/markdown/markdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { openDesktopPath, revealDesktopItemInDir } from "@/app/lib/desktop";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";

import {
  aiopcFileUrl,
  formatBytes,
  type AiopcConnection,
  type SpaceItem,
  type SpaceKind,
  type SpaceSection,
  useAiopc,
  useAiopcProject,
} from "./aiopc-client";
import { AiopcUnavailable } from "./aiopc-status";

type Filter = { type: "all" } | { type: "kind"; kind: SpaceKind } | { type: "section"; section: SpaceSection };
type Tab = "all" | "starred" | "generated";

const KIND_FILTERS: Array<{ kind: SpaceKind; label: string; icon: ComponentType<{ className?: string }> }> = [
  { kind: "document", label: "aiopc.space.kind_document", icon: FileText },
  { kind: "image", label: "aiopc.space.kind_image", icon: ImageIcon },
  { kind: "video", label: "aiopc.space.kind_video", icon: Video },
  { kind: "audio", label: "aiopc.space.kind_audio", icon: AudioLines },
];
const SECTION_FILTERS: Array<{ section: SpaceSection; label: string; icon: ComponentType<{ className?: string }> }> = [
  { section: "brief", label: "aiopc.space.section_brief", icon: BookOpen },
  { section: "knowledge", label: "aiopc.space.section_knowledge", icon: FolderOpen },
  { section: "assets", label: "aiopc.space.section_assets", icon: Package },
  { section: "content", label: "aiopc.space.section_content", icon: PenLine },
];
const TEXT_SUFFIXES = [".md", ".txt", ".csv", ".json"];
const STARRED_KEY = "aiopc.space.starred";
const VIEW_KEY = "aiopc.space.view";

function kindIcon(kind: SpaceKind) {
  return KIND_FILTERS.find((filter) => filter.kind === kind)?.icon ?? FileText;
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

/**
 * 资料空间: every document, image, video and note of the current project. The
 * workspace is the project, so this is the workspace folder the AI writes into.
 */
export function SpacePage(props: { workspaceRoot: string; onAskAi: (prompt: string) => void }) {
  const { connection, ready, request } = useAiopc(props.workspaceRoot);
  const projectQuery = useAiopcProject(props.workspaceRoot);
  const [filter, setFilter] = useState<Filter>({ type: "all" });
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">(() => (window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"));
  const [starred, setStarred] = useState(readStarred);
  const [opened, setOpened] = useState<SpaceItem | null>(null);

  useEffect(() => setOpened(null), [props.workspaceRoot]);

  const spaceQuery = useQuery({
    queryKey: ["aiopc", props.workspaceRoot, "space"],
    enabled: ready,
    queryFn: () => request<{ items: SpaceItem[]; truncated: boolean }>("GET", "/api/space"),
    refetchInterval: 15_000,
  });
  const items = spaceQuery.data?.items ?? [];

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (filter.type === "kind" && item.kind !== filter.kind) return false;
      if (filter.type === "section" && item.section !== filter.section) return false;
      if (tab === "starred" && !starred.has(item.path)) return false;
      if (tab === "generated" && !item.relative.startsWith("assets/generated/")) return false;
      return !needle || item.relative.toLocaleLowerCase().includes(needle);
    });
  }, [filter, items, query, starred, tab]);
  const recent = useMemo(() => items.slice(0, 6), [items]);

  if (!connection || connection.status !== "ready") return <AiopcUnavailable connection={connection} title={t("aiopc.space.title")} />;

  const toggleStar = (item: SpaceItem) => {
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
  const scopeName = projectQuery.data?.name ?? props.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const createPrompts = [
    { label: t("aiopc.space.create_document"), icon: FileText, prompt: t("aiopc.space.create_document_prompt", { project: scopeName }) },
    { label: t("aiopc.space.create_image"), icon: ImageIcon, prompt: t("aiopc.space.create_image_prompt", { project: scopeName }) },
    { label: t("aiopc.space.create_bootstrap"), icon: Sparkles, prompt: t("aiopc.space.create_bootstrap_prompt", { project: scopeName }) },
  ];

  const navButton = (active: boolean, label: string, Icon: ComponentType<{ className?: string }>, onSelect: () => void, count?: number) => (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors",
        active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span> : null}
    </button>
  );

  return (
    <section data-aiopc-space aria-label={t("aiopc.space.title")} className="flex h-full min-h-0">
      <aside className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border/60 px-3 pb-6 pt-6 max-md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button className="w-full justify-start gap-2"><Plus className="size-4" />{t("aiopc.space.create")}</Button>} />
          <DropdownMenuContent align="start" className="w-56">
            {createPrompts.map((item) => (
              <DropdownMenuItem key={item.label} onClick={() => props.onAskAi(item.prompt)}>
                <item.icon className="size-3.5" />
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <nav className="flex flex-col gap-0.5">
          {navButton(filter.type === "all", t("aiopc.space.all"), LayoutGrid, () => setFilter({ type: "all" }), items.length)}
          {KIND_FILTERS.map((option) => navButton(
            filter.type === "kind" && filter.kind === option.kind, t(option.label), option.icon,
            () => setFilter({ type: "kind", kind: option.kind }), items.filter((item) => item.kind === option.kind).length,
          ))}
        </nav>
        <nav className="flex flex-col gap-0.5">
          <h2 className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground">{t("aiopc.space.sections")}</h2>
          {SECTION_FILTERS.map((option) => navButton(
            filter.type === "section" && filter.section === option.section, t(option.label), option.icon,
            () => setFilter({ type: "section", section: option.section }), items.filter((item) => item.section === option.section).length,
          ))}
        </nav>
        {recent.length > 0 ? (
          <nav className="flex flex-col gap-0.5">
            <h2 className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground">{t("aiopc.space.recent")}</h2>
            {recent.map((item) => navButton(false, item.name, kindIcon(item.kind), () => setOpened(item)))}
          </nav>
        ) : null}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 pb-12 pt-8">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">{t("aiopc.space.title")}</h1>
            <span className="truncate text-sm text-muted-foreground" title={props.workspaceRoot}>{scopeName}</span>
            <div className="relative ml-auto w-72 max-w-full">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={t("aiopc.space.search")} className="pl-8" />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <ToggleGroup value={[tab]} onValueChange={(values) => { if (values[0]) setTab(values[0] as Tab); }} variant="segmented" spacing={0.5} size="xs" aria-label={t("aiopc.space.tabs")}>
              <ToggleGroupItem value="all">{t("aiopc.space.tab_all")}</ToggleGroupItem>
              <ToggleGroupItem value="starred">{t("aiopc.space.tab_starred")}</ToggleGroupItem>
              <ToggleGroupItem value="generated">{t("aiopc.space.tab_generated")}</ToggleGroupItem>
            </ToggleGroup>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" aria-label={t("aiopc.refresh")} onClick={() => void spaceQuery.refetch()}>
                <RefreshCw className={cn("size-4", spaceQuery.isFetching && "animate-spin")} />
              </Button>
              <ToggleGroup value={[view]} onValueChange={(values) => { if (values[0]) changeView(values[0] as "grid" | "list"); }} variant="segmented" spacing={0.5} size="xs" aria-label={t("aiopc.space.view")}>
                <ToggleGroupItem value="grid" aria-label={t("aiopc.space.view_grid")}><LayoutGrid className="size-3.5" /></ToggleGroupItem>
                <ToggleGroupItem value="list" aria-label={t("aiopc.space.view_list")}><List className="size-3.5" /></ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>

          {spaceQuery.isError ? (
            <p className="text-sm text-destructive">{spaceQuery.error instanceof Error ? spaceQuery.error.message : String(spaceQuery.error)}</p>
          ) : spaceQuery.isPending ? (
            <p className="py-16 text-center text-sm text-muted-foreground">{t("aiopc.loading")}</p>
          ) : visible.length === 0 ? (
            <SpaceEmpty hasItems={items.length > 0} onAskAi={() => props.onAskAi(createPrompts[2].prompt)} />
          ) : view === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {visible.map((item) => (
                <SpaceCard key={item.path} item={item} connection={connection} workspaceRoot={props.workspaceRoot}
                  starred={starred.has(item.path)} onOpen={() => setOpened(item)} onToggleStar={() => toggleStar(item)} />
              ))}
            </div>
          ) : (
            <div role="list" className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/60">
              {visible.map((item) => {
                const Icon = kindIcon(item.kind);
                return (
                  <button key={item.path} type="button" role="listitem" onClick={() => setOpened(item)}
                    className="flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                    <span className="hidden min-w-0 max-w-64 truncate text-xs text-muted-foreground md:block">{item.relative}</span>
                    <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{formatBytes(item.size)}</span>
                    <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{formatModified(item.modified)}</span>
                    {starred.has(item.path) ? <Star className="size-3.5 shrink-0 fill-current text-amber-500" /> : <span className="size-3.5 shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
          {spaceQuery.data?.truncated ? <p className="text-xs text-muted-foreground">{t("aiopc.space.truncated")}</p> : null}
        </div>
      </div>

      <SpacePreview
        item={opened}
        connection={connection}
        workspaceRoot={props.workspaceRoot}
        starred={opened ? starred.has(opened.path) : false}
        onToggleStar={() => opened && toggleStar(opened)}
        onClose={() => setOpened(null)}
        onAskAi={(item) => {
          setOpened(null);
          props.onAskAi(t("aiopc.space.ask_ai_prompt", { path: item.relative }));
        }}
      />
    </section>
  );
}

function SpaceEmpty(props: { hasItems: boolean; onAskAi: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
      <FolderOpen className="size-8 text-muted-foreground" />
      <div className="text-sm font-medium">{props.hasItems ? t("aiopc.space.no_matches") : t("aiopc.space.empty")}</div>
      {props.hasItems ? null : (
        <>
          <p className="max-w-sm text-xs text-muted-foreground">{t("aiopc.space.empty_hint")}</p>
          <Button variant="outline" size="sm" onClick={props.onAskAi}><Sparkles className="size-3.5" />{t("aiopc.space.create_bootstrap")}</Button>
        </>
      )}
    </div>
  );
}

function SpaceCard(props: {
  item: SpaceItem;
  connection: AiopcConnection;
  workspaceRoot: string;
  starred: boolean;
  onOpen: () => void;
  onToggleStar: () => void;
}) {
  const { item } = props;
  const Icon = kindIcon(item.kind);
  const src = item.kind === "image" || item.kind === "video" ? aiopcFileUrl(props.connection, props.workspaceRoot, item.path) : "";
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card transition-colors hover:border-foreground/20">
      <button type="button" onClick={props.onOpen} className="flex flex-col text-left">
        <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted/40">
          {item.kind === "image" && src ? (
            <img src={src} alt="" loading="lazy" className="size-full object-cover" />
          ) : item.kind === "video" && src ? (
            <video src={src} preload="metadata" muted className="size-full object-cover" />
          ) : (
            <Icon className="size-8 text-muted-foreground/70" />
          )}
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2.5">
          <span className="truncate text-[13px] font-medium">{item.name}</span>
          <span className="truncate text-[11px] text-muted-foreground">{t(`aiopc.space.section_${item.section}`)} · {formatModified(item.modified)}</span>
        </div>
      </button>
      <button
        type="button"
        aria-label={props.starred ? t("aiopc.space.unstar") : t("aiopc.space.star")}
        onClick={props.onToggleStar}
        className={cn("absolute right-2 top-2 rounded-md bg-background/80 p-1 backdrop-blur transition-opacity",
          props.starred ? "opacity-100" : "opacity-0 group-hover:opacity-100")}
      >
        <Star className={cn("size-3.5", props.starred ? "fill-current text-amber-500" : "text-muted-foreground")} />
      </button>
    </div>
  );
}

function SpacePreview(props: {
  item: SpaceItem | null;
  connection: AiopcConnection;
  workspaceRoot: string;
  starred: boolean;
  onToggleStar: () => void;
  onClose: () => void;
  onAskAi: (item: SpaceItem) => void;
}) {
  const { item } = props;
  const src = item ? aiopcFileUrl(props.connection, props.workspaceRoot, item.path) : "";
  const isText = Boolean(item && TEXT_SUFFIXES.some((suffix) => item.name.toLowerCase().endsWith(suffix)));
  const textQuery = useQuery({
    queryKey: ["aiopc", props.workspaceRoot, "file", item?.path, item?.modified],
    enabled: Boolean(item && isText && src),
    queryFn: async () => {
      const response = await fetch(src);
      if (!response.ok) throw new Error(t("aiopc.space.preview_failed"));
      return await response.text();
    },
  });
  const [actionError, setActionError] = useState("");
  useEffect(() => setActionError(""), [item?.path]);
  const run = (action: () => Promise<void>) => void action().catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error)));

  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-4 sm:max-w-3xl">
        {item ? (
          <>
            <DialogHeader>
              <DialogTitle className="truncate">{item.name}</DialogTitle>
              <DialogDescription className="truncate">{item.relative} · {formatBytes(item.size)} · {formatModified(item.modified)}</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-auto rounded-lg bg-muted/30">
              {item.kind === "image" ? (
                <img src={src} alt={item.name} className="mx-auto max-h-[60vh] object-contain" />
              ) : item.kind === "video" ? (
                <video src={src} controls className="mx-auto max-h-[60vh]" />
              ) : item.kind === "audio" ? (
                <audio src={src} controls className="m-6 w-[calc(100%-3rem)]" />
              ) : isText ? (
                <div className="px-5 py-4 text-sm">
                  {textQuery.isPending ? <p className="text-muted-foreground">{t("aiopc.loading")}</p>
                    : textQuery.isError ? <p className="text-destructive">{t("aiopc.space.preview_failed")}</p>
                    : item.name.toLowerCase().endsWith(".md") ? <MarkdownBlock text={textQuery.data ?? ""} />
                    : <pre className="whitespace-pre-wrap break-words font-mono text-xs">{textQuery.data}</pre>}
                </div>
              ) : (
                <p className="px-5 py-10 text-center text-sm text-muted-foreground">{t("aiopc.space.no_preview")}</p>
              )}
            </div>
            {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => props.onAskAi(item)}><MessageSquarePlus className="size-3.5" />{t("aiopc.space.ask_ai")}</Button>
              <Button size="sm" variant="outline" onClick={() => run(() => openDesktopPath(item.path))}><ExternalLink className="size-3.5" />{t("aiopc.space.open")}</Button>
              <Button size="sm" variant="outline" onClick={() => run(() => revealDesktopItemInDir(item.path))}><FolderOpen className="size-3.5" />{t("aiopc.space.reveal")}</Button>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={props.onToggleStar}>
                <Star className={cn("size-3.5", props.starred && "fill-current text-amber-500")} />
                {props.starred ? t("aiopc.space.unstar") : t("aiopc.space.star")}
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
