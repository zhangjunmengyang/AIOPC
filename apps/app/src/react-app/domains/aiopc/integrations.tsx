/** @jsxImportSource react */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { usePlatform } from "@/react-app/kernel/platform";

import { type AiopcAccount, type AiopcEnhancement, type AiopcPlatform, type AiopcRouteField, type AiopcService, useAiopc } from "./aiopc-client";
import { PlatformIcon } from "./platform-icon";

/** A small form for keys: secrets stay masked and are sent once, to be kept in the Keychain. */
function KeyFields(props: { fields: AiopcRouteField[]; values: Record<string, string>; onChange: (values: Record<string, string>) => void }) {
  return (
    <div className="flex flex-col gap-2">
      {props.fields.map((field) => (
        <Input
          key={field.name}
          type={field.secret ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          placeholder={field.label}
          value={props.values[field.name] ?? ""}
          onChange={(event) => props.onChange({ ...props.values, [field.name]: event.currentTarget.value })}
        />
      ))}
    </div>
  );
}

function HelpLink(props: { text: string; url: string }) {
  const platform = usePlatform();
  return (
    <p className="text-xs text-muted-foreground">
      {props.text}
      {props.url ? (
        <button type="button" className="ml-1 inline-flex items-center gap-0.5 text-primary hover:underline" onClick={() => void platform.openLink(props.url)}>
          {t("aiopc.routes.open_guide")}<ExternalLink className="size-3" />
        </button>
      ) : null}
    </p>
  );
}

/** One official route for one account: what it does, its state, and its keys. */
function EnhancementCard(props: { account: AiopcAccount; enhancement: AiopcEnhancement; workspaceRoot: string; onChanged: () => void }) {
  const { request } = useAiopc(props.workspaceRoot);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { enhancement } = props;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      setValues({});
      props.onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{enhancement.name}</span>
          <span className="text-xs text-muted-foreground">{enhancement.does}</span>
        </div>
        {enhancement.attached ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-green-600 dark:text-green-400"><CheckCircle2 className="size-3.5" />{t("aiopc.routes.enabled")}</span>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">{t("aiopc.routes.not_enabled")}</span>
        )}
      </div>
      {enhancement.automatic ? (
        <HelpLink text={enhancement.help} url={enhancement.help_url} />
      ) : enhancement.attached ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" disabled={busy}
            onClick={() => void run(() => request("DELETE", `/api/accounts/${props.account.account_id}/routes/${enhancement.route}`))}>
            {t("aiopc.routes.remove")}
          </Button>
        </div>
      ) : (
        <>
          <KeyFields fields={enhancement.fields} values={values} onChange={setValues} />
          <HelpLink text={enhancement.help} url={enhancement.help_url} />
          <div className="flex justify-end">
            <Button size="sm" disabled={busy || enhancement.fields.some((field) => !values[field.name]?.trim())}
              onClick={() => void run(() => request("POST", `/api/accounts/${props.account.account_id}/routes`, {
                body: { route: enhancement.route, fields: values },
              }))}>
              {busy ? t("aiopc.routes.verifying") : t("aiopc.routes.verify_save")}
            </Button>
          </div>
        </>
      )}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** The official routes an account can add beyond the browser it was connected with. */
export function EnhanceDialog(props: { account: AiopcAccount | null; workspaceRoot: string; onClose: () => void; onChanged: () => void }) {
  return (
    <Dialog open={Boolean(props.account)} onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-4 lg:max-w-lg">
        {props.account ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("aiopc.routes.enhance_title", { name: props.account.name })}</DialogTitle>
              <DialogDescription>{t("aiopc.routes.enhance_hint")}</DialogDescription>
            </DialogHeader>
            <div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1 pb-1">
              {props.account.enhancements.map((enhancement) => (
                <EnhancementCard key={enhancement.route} account={props.account!} enhancement={enhancement}
                  workspaceRoot={props.workspaceRoot} onChanged={props.onChanged} />
              ))}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ServiceCard(props: { service: AiopcService; workspaceRoot: string }) {
  const { request } = useAiopc(props.workspaceRoot);
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { service } = props;
  const save = async (fields: Record<string, string>) => {
    setBusy(true);
    setError("");
    try {
      await request("PUT", `/api/integrations/${service.id}`, { body: { fields } });
      setValues({});
      await queryClient.invalidateQueries({ queryKey: ["aiopc", "integrations"] });
      await queryClient.invalidateQueries({ queryKey: ["aiopc", "accounts"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{service.name}</span>
          <span className="text-xs text-muted-foreground">{service.does}</span>
        </div>
        {service.configured ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-green-600 dark:text-green-400">
            <CheckCircle2 className="size-3.5" />{service.source === "env" ? t("aiopc.routes.configured_env") : t("aiopc.routes.configured")}
          </span>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">{t("aiopc.routes.not_configured")}</span>
        )}
      </div>
      <KeyFields fields={service.fields} values={values} onChange={setValues} />
      <HelpLink text={service.help} url={service.help_url} />
      <div className="flex justify-end gap-1.5">
        {service.source === "keychain" ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void save({})}>{t("aiopc.routes.remove")}</Button>
        ) : null}
        <Button size="sm" disabled={busy || service.fields.some((field) => !values[field.name]?.trim())} onClick={() => void save(values)}>
          {service.configured ? t("aiopc.routes.replace") : t("aiopc.save")}
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * 接口与数据: every way AIOPC reaches platforms beyond the built-in browser, in one place.
 * Shared data services first, then each account's official routes.
 */
export function IntegrationsPanel(props: {
  workspaceRoot: string;
  accounts: AiopcAccount[];
  platforms: AiopcPlatform[];
  onEnhance: (account: AiopcAccount) => void;
  onConnect: () => void;
}) {
  const { ready, request } = useAiopc(props.workspaceRoot);
  const servicesQuery = useQuery({
    queryKey: ["aiopc", "integrations"],
    enabled: ready,
    queryFn: () => request<{ services: AiopcService[] }>("GET", "/api/integrations").then((data) => data.services),
  });
  const enhanceable = props.accounts.filter((account) => account.enhancements.length > 0);
  const platformName = (id: string) => props.platforms.find((item) => item.id === id)?.name ?? id;
  const [missing, setMissing] = useState<string[]>([]);
  useEffect(() => {
    const connected = new Set(props.accounts.map((account) => account.platform));
    setMissing(["x", "bluesky", "github"].filter((id) => !connected.has(id)));
  }, [props.accounts]);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium">{t("aiopc.routes.data_title")}</h2>
          <p className="text-xs text-muted-foreground">{t("aiopc.routes.data_hint")}</p>
        </div>
        {(servicesQuery.data ?? []).map((service) => <ServiceCard key={service.id} service={service} workspaceRoot={props.workspaceRoot} />)}
      </section>
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium">{t("aiopc.routes.api_title")}</h2>
          <p className="text-xs text-muted-foreground">{t("aiopc.routes.api_hint")}</p>
        </div>
        {enhanceable.map((account) => {
          const attached = account.enhancements.filter((item) => item.attached);
          return (
            <div key={account.account_id} className="flex items-center gap-3 rounded-xl border border-border px-4 py-3">
              <PlatformIcon id={account.platform} name={account.platform_name} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">{account.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {attached.length ? attached.map((item) => item.name).join("、") : t("aiopc.routes.browser_only")}
                </span>
              </div>
              <Button variant="outline" size="sm" onClick={() => props.onEnhance(account)}>{t("aiopc.routes.manage")}</Button>
            </div>
          );
        })}
        {missing.length ? (
          <p className={cn("text-xs text-muted-foreground", enhanceable.length && "pt-1")}>
            {t("aiopc.routes.connect_first", { platforms: missing.map(platformName).join("、") })}
            <button type="button" className="ml-1 text-primary hover:underline" onClick={props.onConnect}>{t("aiopc.accounts.connect")}</button>
          </p>
        ) : null}
      </section>
    </div>
  );
}
