/** @jsxImportSource react */
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, ExternalLink, PenLine, Plus, RefreshCw, Search, Trash2, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { usePlatform } from "@/react-app/kernel/platform";

import {
  type AiopcAccount,
  type AiopcPlatform,
  type ConnectResult,
  useAiopc,
  useAiopcPlatforms,
} from "./aiopc-client";
import { AiopcUnavailable } from "./aiopc-status";
import { PlatformIcon } from "./platform-icon";

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
 * 账号: the social accounts AIOPC knows. Logins live in AIOPC's built-in
 * browser, which every project uses, so accounts are shared by all projects;
 * the publishing log below belongs to the current project (workspace).
 */
export function AccountsPage(props: { workspaceRoot: string }) {
  const { connection, ready, request } = useAiopc(props.workspaceRoot);
  const platformBridge = usePlatform();
  const platformsQuery = useAiopcPlatforms(props.workspaceRoot);
  const [connecting, setConnecting] = useState(false);
  // An open login: the page stays usable so the browser panel on the right can be used to log in.
  const [login, setLogin] = useState<{ platform: AiopcPlatform; alias: string } | null>(null);
  const [renaming, setRenaming] = useState<AiopcAccount | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  const accountsQuery = useQuery({
    queryKey: ["aiopc", "accounts"],
    enabled: ready,
    queryFn: () => request<{ accounts: AiopcAccount[] }>("GET", "/api/accounts").then((data) => data.accounts),
  });
  const historyQuery = useQuery({
    queryKey: ["aiopc", props.workspaceRoot, "history"],
    enabled: ready,
    queryFn: () => request<{ items: HistoryEntry[] }>("GET", "/api/history").then((data) => data.items),
    refetchInterval: 30_000,
  });
  const accounts = accountsQuery.data ?? [];
  const accountName = useMemo(() => new Map(accounts.map((account) => [account.account_id, account.name])), [accounts]);
  const platformById = useMemo(() => new Map((platformsQuery.data ?? []).map((item) => [item.id, item])), [platformsQuery.data]);

  if (!connection || connection.status !== "ready") return <AiopcUnavailable connection={connection} title={t("aiopc.accounts.title")} />;

  const refreshAccounts = () => accountsQuery.refetch();
  const act = async (accountId: string, action: () => Promise<unknown>) => {
    setBusyId(accountId);
    setError("");
    try {
      await action();
      await refreshAccounts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId("");
    }
  };
  const recheck = (account: AiopcAccount) => act(account.account_id, async () => {
    const result = await request<ConnectResult>("POST", "/api/accounts/connect", { body: { platform: account.platform, check: true } });
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
          <Button variant="ghost" size="icon-sm" aria-label={t("aiopc.refresh")} onClick={() => void accountsQuery.refetch()}>
            <RefreshCw className={cn("size-4", accountsQuery.isFetching && "animate-spin")} />
          </Button>
          <Button className="ml-auto" onClick={() => setConnecting(true)}><Plus className="size-4" />{t("aiopc.accounts.connect")}</Button>
        </div>
        <p className="-mt-2 text-sm text-muted-foreground">{t("aiopc.accounts.subtitle")}</p>
        {login ? (
          <LoginBar
            key={login.platform.id}
            workspaceRoot={props.workspaceRoot}
            platform={login.platform}
            alias={login.alias}
            onDone={() => {
              setLogin(null);
              void refreshAccounts();
            }}
            onCancel={() => setLogin(null)}
          />
        ) : null}

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
            {accounts.map((account) => {
              const platform = platformById.get(account.platform);
              return (
                <div key={account.account_id} role="listitem" className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <PlatformIcon id={account.platform} name={account.platform_name} color={platform?.color} className="size-9" />
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
                      {account.platform_name}
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
                    <Button variant="ghost" size="icon-sm" aria-label={t("aiopc.accounts.rename")} title={t("aiopc.accounts.rename")} onClick={() => setRenaming(account)}>
                      <PenLine className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={t("aiopc.accounts.remove")} title={t("aiopc.accounts.remove")} onClick={() => remove(account)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
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
        platforms={platformsQuery.data ?? []}
        onOpenChange={setConnecting}
        onLoginOpened={(platform, alias) => setLogin({ platform, alias })}
        onConnected={() => void refreshAccounts()}
      />
      <RenameDialog
        account={renaming}
        workspaceRoot={props.workspaceRoot}
        onClose={() => setRenaming(null)}
        onSaved={() => void refreshAccounts()}
      />
    </section>
  );
}

function ConnectDialog(props: {
  open: boolean;
  workspaceRoot: string;
  platforms: AiopcPlatform[];
  onOpenChange: (open: boolean) => void;
  /** The login page is open in the browser panel; the dialog closes so the panel can be used. */
  onLoginOpened: (platform: AiopcPlatform, alias: string) => void;
  onConnected: () => void;
}) {
  const { request } = useAiopc(props.workspaceRoot);
  const [region, setRegion] = useState<"cn" | "global">("cn");
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<AiopcPlatform | null>(null);
  const [alias, setAlias] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.open) {
      setPlatform(null);
      setAlias("");
      setQuery("");
      setMessage("");
    }
  }, [props.open]);

  // Searching looks across both regions; otherwise one region, grouped by category, connectable first.
  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const shown = props.platforms.filter((item) => needle
      ? item.name.toLocaleLowerCase().includes(needle) || item.id.includes(needle)
      : item.region === region);
    const byCategory = new Map<string, AiopcPlatform[]>();
    for (const item of shown) {
      const label = item.status === "planned" ? t("aiopc.accounts.planned_group") : item.category_name;
      byCategory.set(label, [...(byCategory.get(label) ?? []), item]);
    }
    const planned = t("aiopc.accounts.planned_group");
    return [...byCategory.entries()].sort(([a], [b]) => Number(a === planned) - Number(b === planned));
  }, [props.platforms, query, region]);

  const openLogin = async () => {
    if (!platform) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await request<ConnectResult>("POST", "/api/accounts/connect", {
        body: { platform: platform.id, alias: alias.trim() },
      });
      if (result.status === "connected") props.onConnected();
      else props.onLoginOpened(platform, alias.trim());
      props.onOpenChange(false);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-2xl flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("aiopc.accounts.connect")}</DialogTitle>
          <DialogDescription>{t("aiopc.accounts.connect_hint")}</DialogDescription>
        </DialogHeader>
        {(
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex items-center gap-2">
              <ToggleGroup value={[region]} onValueChange={(values) => { if (values[0]) setRegion(values[0] as "cn" | "global"); }} variant="segmented" spacing={0.5} size="xs" aria-label={t("aiopc.accounts.region")}>
                <ToggleGroupItem value="cn">{t("aiopc.accounts.region_cn")}</ToggleGroupItem>
                <ToggleGroupItem value="global">{t("aiopc.accounts.region_global")}</ToggleGroupItem>
              </ToggleGroup>
              <div className="relative ml-auto w-56">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={t("aiopc.accounts.search_platform")} className="pl-8" />
              </div>
            </div>
            <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
              {groups.map(([label, items]) => (
                <section key={label} className="pb-3">
                  <h3 className="pb-1.5 text-[11px] font-medium text-muted-foreground">{label}</h3>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {items.map((item) => {
                      const planned = item.status === "planned";
                      return (
                        <button
                          key={item.id}
                          type="button"
                          disabled={planned}
                          onClick={() => setPlatform(item)}
                          className={cn("flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left text-sm transition-colors",
                            platform?.id === item.id ? "border-foreground bg-muted" : "border-border hover:bg-muted/60",
                            planned && "cursor-not-allowed hover:bg-transparent")}
                        >
                          <PlatformIcon id={item.id} name={item.name} color={item.color} muted={planned} />
                          <span className="flex min-w-0 flex-col">
                            <span className={cn("truncate font-medium", planned && "text-muted-foreground")}>{item.name}</span>
                            <span className="truncate text-[11px] text-muted-foreground">
                              {planned ? t("aiopc.accounts.planned") : item.forms.map((form) => t(`aiopc.form.${form}`)).join(" · ")}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
              {groups.length === 0 ? <p className="py-8 text-center text-xs text-muted-foreground">{t("aiopc.accounts.no_platform")}</p> : null}
            </div>
            <Input value={alias} onChange={(event) => setAlias(event.currentTarget.value)} placeholder={t("aiopc.accounts.alias")} maxLength={80} />
          </div>
        )}
        {message ? <p className="text-xs text-destructive">{message}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button disabled={!platform || busy} onClick={() => void openLogin()}>{t("aiopc.accounts.open_login")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Shown above the list while a login page is open in the browser panel; nothing here covers the panel. */
function LoginBar(props: { workspaceRoot: string; platform: AiopcPlatform; alias: string; onDone: () => void; onCancel: () => void }) {
  const { request } = useAiopc(props.workspaceRoot);
  const [busy, setBusy] = useState<"" | "check" | "reopen">("");
  const [message, setMessage] = useState("");
  const call = async (check: boolean) => {
    setBusy(check ? "check" : "reopen");
    setMessage("");
    try {
      const result = await request<ConnectResult>("POST", "/api/accounts/connect", {
        body: { platform: props.platform.id, alias: props.alias, check },
      });
      if (result.status === "connected") props.onDone();
      else if (result.status === "not_logged_in") setMessage(t("aiopc.accounts.not_logged_in", { platform: props.platform.name }));
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
      <PlatformIcon id={props.platform.id} name={props.platform.name} color={props.platform.color} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{t("aiopc.accounts.login_title", { platform: props.platform.name })}</span>
        <span className="text-xs text-muted-foreground">{message || t("aiopc.accounts.login_steps")}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={props.onCancel}>{t("common.cancel")}</Button>
        <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void call(false)}>{t("aiopc.accounts.reopen_login")}</Button>
        <Button size="sm" disabled={Boolean(busy)} onClick={() => void call(true)}>{busy === "check" ? t("aiopc.accounts.checking") : t("aiopc.accounts.logged_in")}</Button>
      </div>
    </div>
  );
}

function RenameDialog(props: { account: AiopcAccount | null; workspaceRoot: string; onClose: () => void; onSaved: () => void }) {
  const { request } = useAiopc(props.workspaceRoot);
  const [alias, setAlias] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setAlias(props.account?.name ?? "");
    setError("");
  }, [props.account]);
  const save = async () => {
    if (!props.account) return;
    try {
      await request("PATCH", `/api/accounts/${props.account.account_id}`, { body: { alias: alias.trim() } });
      props.onSaved();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  return (
    <Dialog open={Boolean(props.account)} onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="w-full max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("aiopc.accounts.rename")}</DialogTitle>
          <DialogDescription>{t("aiopc.accounts.rename_hint")}</DialogDescription>
        </DialogHeader>
        <Input autoFocus value={alias} onChange={(event) => setAlias(event.currentTarget.value)} maxLength={80}
          onKeyDown={(event) => { if (event.key === "Enter") void save(); }} />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={props.onClose}>{t("common.cancel")}</Button>
          <Button onClick={() => void save()}>{t("aiopc.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
