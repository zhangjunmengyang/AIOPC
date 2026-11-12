/** @jsxImportSource react */
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { usePlatform } from "@/react-app/kernel/platform";

import { type AiopcAccount, type AiopcEnhancement, type AiopcRouteField, type AiopcService, useAiopc } from "./aiopc-client";

/** A small form for keys: secrets stay masked and are sent once, to be kept in the Keychain. */
export function KeyFields(props: { fields: AiopcRouteField[]; values: Record<string, string>; onChange: (values: Record<string, string>) => void }) {
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

export function HelpLink(props: { text: string; url: string }) {
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
export function EnhancementCard(props: { account: AiopcAccount; enhancement: AiopcEnhancement; workspaceRoot: string; onChanged: () => void }) {
  const { request } = useAiopc(props.workspaceRoot, props.account.environment ?? undefined);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
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
      ) : !expanded ? (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => setExpanded(true)}>{t("aiopc.routes.enable")}</Button>
        </div>
      ) : (
        <>
          <KeyFields fields={enhancement.fields} values={values} onChange={setValues} />
          <HelpLink text={enhancement.help} url={enhancement.help_url} />
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setExpanded(false)}>{t("common.cancel")}</Button>
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

export function ServiceCard(props: { service: AiopcService; workspaceRoot: string }) {
  const { request } = useAiopc(props.workspaceRoot);
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const { service } = props;
  const save = async (fields: Record<string, string>) => {
    setBusy(true);
    setError("");
    try {
      await request("PUT", `/api/integrations/${service.id}`, { body: { fields } });
      setValues({});
      setExpanded(false);
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
      {expanded ? (
        <>
          <KeyFields fields={service.fields} values={values} onChange={setValues} />
          <HelpLink text={service.help} url={service.help_url} />
        </>
      ) : null}
      <div className="flex justify-end gap-1.5">
        {service.source === "keychain" && !expanded ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void save({})}>{t("aiopc.routes.remove")}</Button>
        ) : null}
        {expanded ? (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setExpanded(false)}>{t("common.cancel")}</Button>
            <Button size="sm" disabled={busy || service.fields.some((field) => !values[field.name]?.trim())} onClick={() => void save(values)}>{t("aiopc.save")}</Button>
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setExpanded(true)}>{service.configured ? t("aiopc.routes.replace") : t("aiopc.routes.enable")}</Button>
        )}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
