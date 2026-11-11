/** @jsxImportSource react */
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, ExternalLink, Globe } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { usePlatform } from "@/react-app/kernel/platform";

import {
  type AiopcAccount,
  type AiopcEnhancement,
  type AiopcPlatform,
  type ConnectResult,
  useAiopc,
  useAiopcPlatforms,
} from "./aiopc-client";
import { AiopcUnavailable } from "./aiopc-status";
import { EnhancementCard, HelpLink, KeyFields, ServiceCard } from "./connection-methods";
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

/** A login in progress: through the browser, or GitHub's own authorization. */
type PendingLogin = { platform: AiopcPlatform; method: "auto" | "browser" };

function formatTime(seconds: number | null | undefined) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString(currentLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * 账号: the social accounts AIOPC knows, shared by all projects. Every platform
 * connects through the built-in browser; some also through official APIs. An
 * account's ways in are all managed from that account, not a separate page.
 */
export function AccountsPage(props: { workspaceRoot: string }) {
  const { connection, ready, request } = useAiopc(props.workspaceRoot);
  const platformBridge = usePlatform();
  const platformsQuery = useAiopcPlatforms(props.workspaceRoot);
  const [connecting, setConnecting] = useState(false);
  const [login, setLogin] = useState<PendingLogin | null>(null);
  // Kept by ID so the dialog always shows the account's latest state.
  const [openId, setOpenId] = useState("");

  const accountsQuery = useQuery({
    queryKey: ["aiopc", "accounts"],
    enabled: ready,
    // Accounts also change from chat (the AI connects them): keep the list current without a refresh button.
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    queryFn: () => request<{ accounts: AiopcAccount[] }>("GET", "/api/accounts").then((data) => data.accounts),
  });
  const historyQuery = useQuery({
    queryKey: ["aiopc", props.workspaceRoot, "history"],
    enabled: ready,
    queryFn: () => request<{ items: HistoryEntry[] }>("GET", "/api/history").then((data) => data.items),
    refetchInterval: 30_000,
  });
  const accounts = accountsQuery.data ?? [];
  const platforms = platformsQuery.data ?? [];
  const accountName = useMemo(() => new Map(accounts.map((account) => [account.account_id, account.name])), [accounts]);
  const platformById = useMemo(() => new Map(platforms.map((item) => [item.id, item])), [platforms]);

  if (!connection || connection.status !== "ready") return <AiopcUnavailable connection={connection} title={t("aiopc.accounts.title")} />;

  const refreshAccounts = () => accountsQuery.refetch();
  const opened = accounts.find((account) => account.account_id === openId) ?? null;

  return (
    <section data-aiopc-accounts aria-label={t("aiopc.accounts.title")} className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 pb-12 pt-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t("aiopc.accounts.title")}</h1>
          <Button className="ml-auto" onClick={() => setConnecting(true)}>{t("aiopc.accounts.connect")}</Button>
        </div>
        <p className="-mt-2 text-sm text-muted-foreground">{t("aiopc.accounts.subtitle")}</p>
        {login ? (
          <LoginBar
            key={`${login.platform.id}-${login.method}`}
            workspaceRoot={props.workspaceRoot}
            platform={login.platform}
            method={login.method}
            onDone={() => {
              setLogin(null);
              void refreshAccounts();
            }}
            onCancel={() => setLogin(null)}
          />
        ) : null}

        {accountsQuery.isError ? (
          <p className="text-sm text-destructive">{accountsQuery.error instanceof Error ? accountsQuery.error.message : String(accountsQuery.error)}</p>
        ) : accountsQuery.isPending ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("aiopc.loading")}</p>
        ) : accounts.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t("aiopc.accounts.empty_hint")}</p>
        ) : (
          <div role="list" className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
            {accounts.map((account) => (
              <button
                key={account.account_id}
                type="button"
                role="listitem"
                onClick={() => setOpenId(account.account_id)}
                className="flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
              >
                <PlatformIcon id={account.platform} name={account.platform_name} color={platformById.get(account.platform)?.color} className="size-9" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{account.name}</span>
                    {account.handle ? <span className="truncate text-xs text-muted-foreground">@{account.handle.replace(/^@/, "")}</span> : null}
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{account.platform_name}</span>
                    {account.routes.map((route) => (
                      <span key={route.id} className={cn("rounded-md px-1.5 py-px text-[11px]",
                        route.kind === "browser" ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary")}>{route.name}</span>
                    ))}
                    {account.status !== "ready" ? <span className="text-warning">{t("aiopc.accounts.needs_login")}</span> : null}
                  </div>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
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
        platforms={platforms}
        onOpenChange={setConnecting}
        onLogin={(platform, method) => setLogin({ platform, method })}
        onConnected={() => void refreshAccounts()}
      />
      <AccountDialog
        account={opened}
        platform={opened ? platformById.get(opened.platform) ?? null : null}
        workspaceRoot={props.workspaceRoot}
        onClose={() => setOpenId("")}
        onChanged={() => void refreshAccounts()}
        onRelogin={(platform, method) => {
          setOpenId("");
          setLogin({ platform, method });
        }}
      />
    </section>
  );
}

/** The browser login, as one of an account's ways in. */
function BrowserMethodCard(props: { title: string; does: string; status?: ReactNode; action: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border p-4">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted"><Globe className="size-4 text-muted-foreground" /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{props.title}</span>
          {props.status}
        </div>
        <span className="text-xs text-muted-foreground">{props.does}</span>
      </div>
      <div className="shrink-0">{props.action}</div>
    </div>
  );
}

function ConnectDialog(props: {
  open: boolean;
  workspaceRoot: string;
  platforms: AiopcPlatform[];
  onOpenChange: (open: boolean) => void;
  onLogin: (platform: AiopcPlatform, method: "auto" | "browser") => void;
  onConnected: () => void;
}) {
  const [region, setRegion] = useState<"cn" | "global">("cn");
  // A platform with more than one way in shows its choices before anything opens.
  const [chosen, setChosen] = useState<AiopcPlatform | null>(null);

  useEffect(() => {
    if (!props.open) setChosen(null);
  }, [props.open]);

  const groups = useMemo(() => {
    const byCategory = new Map<string, AiopcPlatform[]>();
    for (const item of props.platforms.filter((platform) => platform.region === region)) {
      byCategory.set(item.category_name, [...(byCategory.get(item.category_name) ?? []), item]);
    }
    return [...byCategory.entries()];
  }, [props.platforms, region]);

  const login = (platform: AiopcPlatform, method: "auto" | "browser") => {
    props.onLogin(platform, method);
    props.onOpenChange(false);
  };
  const choose = (platform: AiopcPlatform) => {
    if (platform.methods.length === 0) login(platform, "browser");
    else setChosen(platform);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-6 lg:max-w-[760px]">
        {chosen ? (
          <MethodPicker
            platform={chosen}
            workspaceRoot={props.workspaceRoot}
            onBack={() => setChosen(null)}
            onLogin={(method) => login(chosen, method)}
            onConnected={() => {
              props.onConnected();
              props.onOpenChange(false);
            }}
          />
        ) : (
          <>
            <DialogHeader className="flex-row items-center justify-between gap-4 pr-10">
              <DialogTitle>{t("aiopc.accounts.connect")}</DialogTitle>
              <ToggleGroup value={[region]} onValueChange={(values) => { if (values[0]) setRegion(values[0] as "cn" | "global"); }} variant="segmented" spacing={0.5} size="xs" aria-label={t("aiopc.accounts.region")}>
                <ToggleGroupItem value="cn">{t("aiopc.accounts.region_cn")}</ToggleGroupItem>
                <ToggleGroupItem value="global">{t("aiopc.accounts.region_global")}</ToggleGroupItem>
              </ToggleGroup>
            </DialogHeader>
            <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2 pb-6">
              {groups.map(([label, items]) => (
                <section key={label} className="pb-6 last:pb-0">
                  <h3 className="pb-3 text-xs font-medium text-muted-foreground">{label}</h3>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-x-2 gap-y-4">
                    {items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => choose(item)}
                        className="flex flex-col items-center gap-2 rounded-2xl px-1.5 pb-2 pt-3 transition-colors hover:bg-muted/70"
                      >
                        <PlatformIcon id={item.id} name={item.name} color={item.color} className="size-12 rounded-xl" large />
                        <span className="line-clamp-2 w-full text-center text-xs leading-snug">{item.name}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The ways into one platform: its official route (if any), or the built-in browser that always works. */
function MethodPicker(props: {
  platform: AiopcPlatform;
  workspaceRoot: string;
  onBack: () => void;
  onLogin: (method: "auto" | "browser") => void;
  onConnected: () => void;
}) {
  const { request } = useAiopc(props.workspaceRoot);
  const [form, setForm] = useState<Omit<AiopcEnhancement, "attached"> | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!form) return;
    setBusy(true);
    setError("");
    try {
      await request("POST", "/api/accounts/connect-route", { body: { platform: props.platform.id, route: form.route, fields: values } });
      props.onConnected();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DialogHeader className="flex-row items-center gap-3 pr-10">
        <Button variant="ghost" size="icon-sm" aria-label={t("aiopc.accounts.back")} onClick={form ? () => setForm(null) : props.onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <PlatformIcon id={props.platform.id} name={props.platform.name} color={props.platform.color} />
        <div className="flex flex-col">
          <DialogTitle>{t("aiopc.accounts.connect_platform", { platform: props.platform.name })}</DialogTitle>
          <DialogDescription>{form ? form.does : t("aiopc.accounts.choose_method")}</DialogDescription>
        </div>
      </DialogHeader>
      {form ? (
        <div className="flex flex-col gap-3">
          <KeyFields fields={form.fields} values={values} onChange={setValues} />
          <HelpLink text={form.help} url={form.help_url} />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="flex justify-end">
            <Button disabled={busy || form.fields.some((field) => !values[field.name]?.trim())} onClick={() => void submit()}>
              {busy ? t("aiopc.routes.verifying") : t("aiopc.accounts.connect")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {props.platform.methods.map((method) => (
            <button key={method.route} type="button"
              onClick={() => (method.automatic ? props.onLogin("auto") : setForm(method))}
              className="flex items-start gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:bg-muted/50">
              <PlatformIcon id={props.platform.id} name={props.platform.name} color={props.platform.color} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{method.name}</span>
                <span className="text-xs text-muted-foreground">{method.does}</span>
              </div>
              <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
          <button type="button" onClick={() => props.onLogin("browser")}
            className="flex items-start gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:bg-muted/50">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted"><Globe className="size-4 text-muted-foreground" /></span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">{t("aiopc.accounts.method_browser")}</span>
              <span className="text-xs text-muted-foreground">{t("aiopc.accounts.method_browser_does")}</span>
            </div>
            <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground" />
          </button>
        </div>
      )}
    </>
  );
}

/** One account: every way AIOPC reaches it, its name, and removal. */
function AccountDialog(props: {
  account: AiopcAccount | null;
  platform: AiopcPlatform | null;
  workspaceRoot: string;
  onClose: () => void;
  onChanged: () => void;
  onRelogin: (platform: AiopcPlatform, method: "auto" | "browser") => void;
}) {
  const { request } = useAiopc(props.workspaceRoot);
  const platformBridge = usePlatform();
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const account = props.account;
  useEffect(() => {
    setAlias(account?.name ?? "");
    setMessage("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.account_id]);
  if (!account) return null;

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setMessage("");
    try {
      await action();
      props.onChanged();
      return true;
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy("");
    }
  };
  const check = () => run("check", async () => {
    const result = await request<ConnectResult>("POST", "/api/accounts/connect", {
      body: { platform: account.platform, check: true, method: account.platform === "github" ? "auto" : "browser" },
    });
    if (result.status !== "connected") throw new Error(t("aiopc.accounts.not_logged_in", { platform: account.platform_name }));
  });
  const remove = () => {
    if (!window.confirm(t("aiopc.accounts.remove_confirm", { name: account.name }))) return;
    void run("remove", () => request("DELETE", `/api/accounts/${account.account_id}`)).then((ok) => { if (ok) props.onClose(); });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-5 lg:max-w-xl">
        <DialogHeader className="flex-row items-center gap-3 pr-10">
          <PlatformIcon id={account.platform} name={account.platform_name} color={props.platform?.color} className="size-10" />
          <div className="flex min-w-0 flex-col">
            <DialogTitle className="truncate">{account.name}</DialogTitle>
            <DialogDescription className="truncate">
              {account.platform_name}{account.handle ? ` · @${account.handle.replace(/^@/, "")}` : ""}
            </DialogDescription>
          </div>
          {account.url ? (
            <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={t("aiopc.accounts.open_profile")} title={t("aiopc.accounts.open_profile")}
              onClick={() => void platformBridge.openLink(account.url)}>
              <ExternalLink className="size-4" />
            </Button>
          ) : null}
        </DialogHeader>

        <div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1 pb-1">
          <h3 className="text-xs font-medium text-muted-foreground">{t("aiopc.accounts.ways_in")}</h3>
          <BrowserMethodCard
            title={t("aiopc.accounts.method_browser")}
            does={t("aiopc.accounts.method_browser_does")}
            status={account.status === "ready"
              ? <span className="text-xs text-green-600 dark:text-green-400">{t("aiopc.accounts.ready")}</span>
              : <span className="text-xs text-warning">{t("aiopc.accounts.needs_login")}</span>}
            action={(
              <div className="flex gap-1.5">
                <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void check()}>
                  {busy === "check" ? t("aiopc.accounts.checking") : t("aiopc.accounts.recheck")}
                </Button>
                {props.platform ? (
                  <Button variant="outline" size="sm" onClick={() => props.onRelogin(props.platform!, "browser")}>{t("aiopc.accounts.relogin")}</Button>
                ) : null}
              </div>
            )}
          />
          {account.enhancements.map((enhancement) => (
            <EnhancementCard key={enhancement.route} account={account} enhancement={enhancement}
              workspaceRoot={props.workspaceRoot} onChanged={props.onChanged} />
          ))}
          {account.services.map((service) => <ServiceCard key={service.id} service={service} workspaceRoot={props.workspaceRoot} />)}

          <h3 className="pt-2 text-xs font-medium text-muted-foreground">{t("aiopc.accounts.display_name")}</h3>
          <div className="flex gap-2">
            <Input value={alias} maxLength={80} onChange={(event) => setAlias(event.currentTarget.value)} />
            <Button variant="outline" disabled={Boolean(busy) || !alias.trim() || alias.trim() === account.name}
              onClick={() => void run("alias", () => request("PATCH", `/api/accounts/${account.account_id}`, { body: { alias: alias.trim() } }))}>
              {t("aiopc.save")}
            </Button>
          </div>
          {message ? <p className="text-xs text-destructive">{message}</p> : null}
          <div className="flex justify-end pt-2">
            <Button variant="ghost" size="sm" className="text-destructive" disabled={Boolean(busy)} onClick={remove}>{t("aiopc.accounts.remove")}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Shown above the list while a login is open in the browser panel; nothing here covers the panel. */
function LoginBar(props: { workspaceRoot: string; platform: AiopcPlatform; method: "auto" | "browser"; onDone: () => void; onCancel: () => void }) {
  const { request } = useAiopc(props.workspaceRoot);
  const [busy, setBusy] = useState<"" | "open" | "check">("open");
  const [message, setMessage] = useState("");
  // GitHub authorizes with a one-time code; once shown, AIOPC checks for the approval by itself.
  const [deviceCode, setDeviceCode] = useState("");
  const call = async (check: boolean, quiet = false) => {
    if (!quiet) {
      setBusy(check ? "check" : "open");
      setMessage("");
    }
    try {
      const result = await request<ConnectResult>("POST", "/api/accounts/connect", {
        body: { platform: props.platform.id, check, method: props.method },
      });
      if (result.status === "connected") props.onDone();
      else if (result.status === "authorize") setDeviceCode(result.code);
      else if (result.status === "not_logged_in" && !quiet) setMessage(t("aiopc.accounts.not_logged_in", { platform: props.platform.name }));
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!quiet) setBusy("");
    }
  };
  // Opening the login page is the first step; it runs in the background while the page stays usable.
  useEffect(() => {
    void call(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!deviceCode) return;
    const timer = window.setInterval(() => void call(true, true), 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceCode]);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/40 p-4">
      <div className="flex items-center gap-3">
        <PlatformIcon id={props.platform.id} name={props.platform.name} color={props.platform.color} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">{t("aiopc.accounts.login_title", { platform: props.platform.name })}</span>
          <span className={cn("text-xs", message ? "text-destructive" : "text-muted-foreground")}>
            {message || (deviceCode ? t("aiopc.accounts.device_steps") : busy === "open" ? t("aiopc.accounts.opening_login") : t("aiopc.accounts.login_steps"))}
          </span>
        </div>
        {deviceCode ? (
          <span className="ml-auto shrink-0 rounded-lg bg-background px-3 py-1.5 font-mono text-lg font-semibold tracking-widest">{deviceCode}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={props.onCancel}>{t("common.cancel")}</Button>
        <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void call(false)}>{t("aiopc.accounts.reopen_login")}</Button>
        {deviceCode ? null : (
          <Button size="sm" disabled={Boolean(busy)} onClick={() => void call(true)}>{busy === "check" ? t("aiopc.accounts.checking") : t("aiopc.accounts.logged_in")}</Button>
        )}
      </div>
    </div>
  );
}
