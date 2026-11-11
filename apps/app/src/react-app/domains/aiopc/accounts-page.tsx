/** @jsxImportSource react */
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, ExternalLink, Plus, RefreshCw, Share2, Trash2, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { currentLocale, t } from "@/i18n";
import { usePlatform } from "@/react-app/kernel/platform";
import { cn } from "@/lib/utils";

import {
  type AiopcAccount,
  type AiopcPlatform,
  type AiopcProject,
  type ConnectResult,
  readSelectedProject,
  useAiopc,
  useAiopcProjects,
  writeSelectedProject,
} from "./aiopc-client";
import { AiopcUnavailable } from "./aiopc-status";
import { ProjectSwitcher } from "./project-switcher";

type HistoryEntry = {
  at: number;
  account_id: string;
  platform: string;
  action: "compose" | "published";
  status: string;
  page_url?: string;
  url?: string;
  error?: string;
};

function formatTime(seconds: number | null | undefined) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString(currentLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * 账号: the social accounts the lab and each project use. Logins live in
 * AIOPC's built-in browser; this page connects, checks and shares them.
 */
export function AccountsPage(props: { workspaceRoot: string }) {
  const { connection, ready, request, invalidate } = useAiopc(props.workspaceRoot);
  const platformBridge = usePlatform();
  const projectsQuery = useAiopcProjects(props.workspaceRoot);
  const [projectId, setProjectId] = useState(() => readSelectedProject(props.workspaceRoot));
  const [scope, setScope] = useState<"project" | "all">("project");
  const [connecting, setConnecting] = useState(false);
  const [sharing, setSharing] = useState<AiopcAccount | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  useEffect(() => setProjectId(readSelectedProject(props.workspaceRoot)), [props.workspaceRoot]);
  const projects = projectsQuery.data ?? [];
  const project = projects.find((item) => item.id === projectId) ?? projects[0];
  const projectName = (id: string) => (id === "*" ? t("aiopc.accounts.all_projects") : projects.find((item) => item.id === id)?.name ?? id);

  const accountsQuery = useQuery({
    queryKey: ["aiopc", props.workspaceRoot, "accounts", scope, project?.id ?? "lab"],
    enabled: ready && Boolean(project),
    queryFn: () => request<{ accounts: AiopcAccount[] }>("GET", "/api/accounts", {
      params: { project: project?.id, all: scope === "all" ? "1" : undefined },
    }).then((data) => data.accounts),
  });
  const historyQuery = useQuery({
    queryKey: ["aiopc", props.workspaceRoot, "history", project?.id ?? "lab"],
    enabled: ready && Boolean(project),
    queryFn: () => request<{ items: HistoryEntry[] }>("GET", "/api/history", { params: { project: project?.id } }).then((data) => data.items),
    refetchInterval: 30_000,
  });
  const accounts = accountsQuery.data ?? [];
  const accountName = useMemo(() => new Map(accounts.map((account) => [account.account_id, account.name])), [accounts]);

  if (!connection || connection.status !== "ready") return <AiopcUnavailable connection={connection} title={t("aiopc.accounts.title")} />;

  const chooseProject = (id: string) => {
    setProjectId(id);
    writeSelectedProject(props.workspaceRoot, id);
  };
  const act = async (accountId: string, action: () => Promise<unknown>) => {
    setBusyId(accountId);
    setError("");
    try {
      await action();
      await invalidate("accounts");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId("");
    }
  };
  const recheck = (account: AiopcAccount) => act(account.account_id, async () => {
    const result = await request<ConnectResult>("POST", "/api/accounts/connect", {
      body: { platform: account.platform, project: account.owner, check: true },
    });
    if (result.status !== "connected") throw new Error(result.message);
  });
  const remove = (account: AiopcAccount) => {
    if (!window.confirm(t("aiopc.accounts.remove_confirm", { name: account.name }))) return;
    void act(account.account_id, () => request("DELETE", `/api/accounts/${account.account_id}`));
  };

  return (
    <section data-aiopc-accounts aria-label={t("aiopc.accounts.title")} className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 pb-12 pt-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t("aiopc.accounts.title")}</h1>
          <ProjectSwitcher workspaceRoot={props.workspaceRoot} projects={projects} value={project?.id ?? "lab"} onChange={chooseProject} />
          <Button className="ml-auto" onClick={() => setConnecting(true)}><Plus className="size-4" />{t("aiopc.accounts.connect")}</Button>
        </div>
        <p className="-mt-2 text-sm text-muted-foreground">{t("aiopc.accounts.subtitle")}</p>

        <div className="flex items-center justify-between gap-3">
          <ToggleGroup value={[scope]} onValueChange={(values) => { if (values[0]) setScope(values[0] as "project" | "all"); }} variant="segmented" spacing={0.5} size="xs" aria-label={t("aiopc.accounts.scope")}>
            <ToggleGroupItem value="project">{t("aiopc.accounts.scope_project", { project: project?.name ?? "" })}</ToggleGroupItem>
            <ToggleGroupItem value="all">{t("aiopc.accounts.scope_all")}</ToggleGroupItem>
          </ToggleGroup>
          <Button variant="ghost" size="icon-sm" aria-label={t("aiopc.refresh")} onClick={() => void accountsQuery.refetch()}>
            <RefreshCw className={cn("size-4", accountsQuery.isFetching && "animate-spin")} />
          </Button>
        </div>

        {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}
        {accountsQuery.isError ? (
          <p className="text-sm text-destructive">{accountsQuery.error instanceof Error ? accountsQuery.error.message : String(accountsQuery.error)}</p>
        ) : accountsQuery.isPending ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("aiopc.loading")}</p>
        ) : accounts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-14 text-center">
            <UserRound className="size-8 text-muted-foreground" />
            <div className="text-sm font-medium">{t("aiopc.accounts.empty")}</div>
            <p className="max-w-sm text-xs text-muted-foreground">{t("aiopc.accounts.empty_hint")}</p>
            <Button variant="outline" size="sm" onClick={() => setConnecting(true)}><Plus className="size-3.5" />{t("aiopc.accounts.connect")}</Button>
          </div>
        ) : (
          <div role="list" className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/60">
            {accounts.map((account) => (
              <div key={account.account_id} role="listitem" className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                  {account.platform_name.slice(0, 2)}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{account.name}</span>
                    {account.handle ? <span className="truncate text-xs text-muted-foreground">@{account.handle.replace(/^@/, "")}</span> : null}
                    {account.status === "ready" ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400"><CheckCircle2 className="size-3" />{t("aiopc.accounts.ready")}</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] text-warning"><CircleAlert className="size-3" />{t("aiopc.accounts.needs_login")}</span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {account.platform_name} · {t("aiopc.accounts.owner", { project: projectName(account.owner) })}
                    {account.shared_with.length ? ` · ${t("aiopc.accounts.shared", { projects: account.shared_with.map(projectName).join("、") })}` : ""}
                    {account.verified_at ? ` · ${t("aiopc.accounts.verified", { time: formatTime(account.verified_at) })}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {account.url ? (
                    <Button variant="ghost" size="icon-sm" aria-label={t("aiopc.accounts.open_profile")} title={t("aiopc.accounts.open_profile")}
                      onClick={() => void platformBridge.openLink(account.url)}>
                      <ExternalLink className="size-4" />
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="icon-sm" aria-label={t("aiopc.accounts.recheck")} title={t("aiopc.accounts.recheck")}
                    disabled={busyId === account.account_id} onClick={() => void recheck(account)}>
                    <RefreshCw className={cn("size-4", busyId === account.account_id && "animate-spin")} />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={t("aiopc.accounts.share")} title={t("aiopc.accounts.share")} onClick={() => setSharing(account)}>
                    <Share2 className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={t("aiopc.accounts.remove")} title={t("aiopc.accounts.remove")} onClick={() => remove(account)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2 pt-4">
          <h2 className="text-sm font-medium">{t("aiopc.accounts.history")}</h2>
          {(historyQuery.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("aiopc.accounts.history_empty")}</p>
          ) : (
            <div className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/60">
              {(historyQuery.data ?? []).slice(0, 20).map((entry, index) => (
                <div key={`${entry.at}-${index}`} className="flex items-center gap-3 px-4 py-2 text-xs">
                  <span className="w-28 shrink-0 text-muted-foreground">{formatTime(entry.at)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {accountName.get(entry.account_id) ?? entry.platform} · {entry.action === "published"
                      ? t("aiopc.accounts.history_published")
                      : entry.status === "failed" ? t("aiopc.accounts.history_failed", { error: entry.error ?? "" }) : t("aiopc.accounts.history_composed")}
                  </span>
                  {entry.url || entry.page_url ? (
                    <button type="button" className="shrink-0 text-primary hover:underline" onClick={() => void platformBridge.openLink(entry.url || entry.page_url || "")}>
                      {t("aiopc.accounts.history_open")}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ConnectDialog
        open={connecting}
        workspaceRoot={props.workspaceRoot}
        project={project}
        onOpenChange={setConnecting}
        onConnected={() => void invalidate("accounts")}
      />
      <ShareDialog
        account={sharing}
        projects={projects}
        workspaceRoot={props.workspaceRoot}
        onClose={() => setSharing(null)}
        onSaved={() => void invalidate("accounts")}
      />
    </section>
  );
}

function ConnectDialog(props: {
  open: boolean;
  workspaceRoot: string;
  project: AiopcProject | undefined;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const { ready, request } = useAiopc(props.workspaceRoot);
  const platformsQuery = useQuery({
    queryKey: ["aiopc", props.workspaceRoot, "platforms"],
    enabled: ready && props.open,
    queryFn: () => request<{ platforms: AiopcPlatform[] }>("GET", "/api/platforms").then((data) => data.platforms),
    staleTime: Infinity,
  });
  const [platform, setPlatform] = useState<AiopcPlatform | null>(null);
  const [alias, setAlias] = useState("");
  const [step, setStep] = useState<"choose" | "login">("choose");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.open) {
      setPlatform(null);
      setAlias("");
      setStep("choose");
      setMessage("");
    }
  }, [props.open]);

  const connect = async (check: boolean) => {
    if (!platform) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await request<ConnectResult>("POST", "/api/accounts/connect", {
        body: { platform: platform.id, project: props.project?.id ?? "lab", alias: alias.trim(), check },
      });
      if (result.status === "connected") {
        props.onConnected();
        props.onOpenChange(false);
        return;
      }
      setStep("login");
      setMessage(result.message);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="w-full max-w-lg sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("aiopc.accounts.connect")}</DialogTitle>
          <DialogDescription>{t("aiopc.accounts.connect_hint", { project: props.project?.name ?? "" })}</DialogDescription>
        </DialogHeader>
        {step === "choose" ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {(platformsQuery.data ?? []).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setPlatform(item)}
                  className={cn("rounded-lg border px-2 py-2.5 text-sm transition-colors",
                    platform?.id === item.id ? "border-foreground bg-muted font-medium" : "border-border hover:bg-muted/60")}
                >
                  {item.name}
                </button>
              ))}
            </div>
            {platformsQuery.isPending ? <p className="text-xs text-muted-foreground">{t("aiopc.loading")}</p> : null}
            <Input value={alias} onChange={(event) => setAlias(event.currentTarget.value)} placeholder={t("aiopc.accounts.alias")} maxLength={80} />
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-4 py-3 text-sm">
            <p>{t("aiopc.accounts.login_steps", { platform: platform?.name ?? "" })}</p>
          </div>
        )}
        {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>{t("common.cancel")}</Button>
          {step === "choose" ? (
            <Button disabled={!platform || busy} onClick={() => void connect(false)}>{t("aiopc.accounts.open_login")}</Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => void connect(false)}>{t("aiopc.accounts.reopen_login")}</Button>
              <Button disabled={busy} onClick={() => void connect(true)}>{busy ? t("aiopc.accounts.checking") : t("aiopc.accounts.logged_in")}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShareDialog(props: {
  account: AiopcAccount | null;
  projects: AiopcProject[];
  workspaceRoot: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { request } = useAiopc(props.workspaceRoot);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSelected(new Set(props.account?.shared_with ?? []));
    setError("");
  }, [props.account]);
  const everyone = selected.has("*");
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const save = async () => {
    if (!props.account) return;
    setBusy(true);
    try {
      await request("PATCH", `/api/accounts/${props.account.account_id}`, { body: { shared_with: everyone ? ["*"] : [...selected] } });
      props.onSaved();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  const others = props.projects.filter((project) => project.id !== props.account?.owner);
  return (
    <Dialog open={Boolean(props.account)} onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="w-full max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("aiopc.accounts.share_title", { name: props.account?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("aiopc.accounts.share_hint")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={everyone} onCheckedChange={() => toggle("*")} />
            {t("aiopc.accounts.all_projects")}
          </label>
          {others.map((project) => (
            <label key={project.id} className={cn("flex items-center gap-2 text-sm", everyone && "opacity-50")}>
              <Checkbox checked={everyone || selected.has(project.id)} disabled={everyone} onCheckedChange={() => toggle(project.id)} />
              {project.name}
            </label>
          ))}
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={props.onClose}>{t("common.cancel")}</Button>
          <Button disabled={busy} onClick={() => void save()}>{t("aiopc.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
