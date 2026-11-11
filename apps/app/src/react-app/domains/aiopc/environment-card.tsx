/** @jsxImportSource react */
import { Check, Cpu, Loader2, MonitorPlay, Settings2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { type AiopcEnvironment, type AiopcProvider, useAiopc, useAiopcEnvironment } from "./aiopc-client";
import { HelpLink, KeyFields } from "./connection-methods";

/**
 * 项目环境: the computer this project's browser runs on. The local sandbox is
 * free and needs nothing; a person who already pays for a cloud browser points
 * the project at that instead. Everything else in AIOPC works the same either way.
 */
export function EnvironmentCard(props: { workspaceRoot: string; onWatch?: () => void }) {
  const { request } = useAiopc(props.workspaceRoot);
  const environmentQuery = useAiopcEnvironment(props.workspaceRoot);
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const environment = environmentQuery.data ?? null;

  const act = async (action: string, body: Record<string, unknown> = {}) => {
    setBusy(action);
    setProblem("");
    try {
      await request("POST", "/api/environment", { body: { action, ...body } });
      await environmentQuery.refetch();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  if (!environment) return null;
  const provider = environment.providers.find((item) => item.id === environment.provider_id) ?? null;
  const local = environment.providers.find((item) => item.id === "local");
  const noEngine = environment.provider_id === "local" && local !== undefined && !local.available;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Cpu className="size-4 text-muted-foreground" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium">{t("aiopc.environment.title")}</span>
          <span className="text-xs text-muted-foreground">
            {environment.engine === "embedded"
              ? t("aiopc.environment.using_builtin")
              : t("aiopc.environment.using_provider", { name: provider?.name ?? environment.provider_id })}
            {environment.running ? ` · ${t("aiopc.environment.running")}` : ""}
          </span>
        </div>
        {environment.running && environment.live_view_url && props.onWatch ? (
          <Button variant="outline" size="sm" onClick={props.onWatch}>
            <MonitorPlay className="size-3.5" />
            {t("aiopc.environment.watch")}
          </Button>
        ) : null}
        {environment.engine === "sandbox" && !environment.running ? (
          <Button size="sm" disabled={busy !== "" || noEngine} onClick={() => void act("start")}>
            {busy === "start" ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("aiopc.environment.start")}
          </Button>
        ) : null}
        <Button variant="ghost" size="icon" aria-label={t("aiopc.environment.settings")} onClick={() => setSettingsOpen(true)}>
          <Settings2 className="size-4" />
        </Button>
      </div>
      {noEngine ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{t("aiopc.environment.needs_engine")}</span>
          <Button size="sm" variant="outline" disabled={busy !== ""} onClick={() => void act("install-engine")}>
            {busy === "install-engine" ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("aiopc.environment.install_engine")}
          </Button>
        </div>
      ) : null}
      {problem ? <p className="text-xs text-destructive">{problem}</p> : null}

      <EnvironmentSettings
        open={settingsOpen}
        environment={environment}
        workspaceRoot={props.workspaceRoot}
        busy={busy}
        onOpenChange={setSettingsOpen}
        onAct={act}
        onSaved={() => void environmentQuery.refetch()}
      />
    </div>
  );
}

function EnvironmentSettings(props: {
  open: boolean;
  environment: AiopcEnvironment;
  workspaceRoot: string;
  busy: string;
  onOpenChange: (open: boolean) => void;
  onAct: (action: string, body?: Record<string, unknown>) => Promise<void>;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState("");

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="lg:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>{t("aiopc.environment.title")}</DialogTitle>
          <DialogDescription>{t("aiopc.environment.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto pb-2">
          {props.environment.providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              chosen={provider.id === props.environment.provider_id}
              editing={editing === provider.id}
              workspaceRoot={props.workspaceRoot}
              onEdit={() => setEditing(editing === provider.id ? "" : provider.id)}
              onChoose={() => void props.onAct("provider", { provider: provider.id })}
              onSaved={() => {
                setEditing("");
                props.onSaved();
              }}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <Button variant="outline" size="sm" disabled={props.busy !== ""} onClick={() => void props.onAct("migrate")}>
            {t("aiopc.environment.migrate")}
          </Button>
          <Button variant="outline" size="sm" disabled={props.busy !== ""} onClick={() => void props.onAct("stop")}>
            {t("aiopc.environment.stop")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={props.busy !== ""}
            onClick={() => void props.onAct("destroy")}
          >
            {t("aiopc.environment.destroy")}
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">
            {props.environment.engine === "sandbox" ? (
              <button type="button" className="hover:underline" onClick={() => void props.onAct("engine", { engine: "embedded" })}>
                {t("aiopc.environment.use_builtin")}
              </button>
            ) : (
              <button type="button" className="hover:underline" onClick={() => void props.onAct("engine", { engine: "sandbox" })}>
                {t("aiopc.environment.use_sandbox")}
              </button>
            )}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProviderRow(props: {
  provider: AiopcProvider;
  chosen: boolean;
  editing: boolean;
  workspaceRoot: string;
  onEdit: () => void;
  onChoose: () => void;
  onSaved: () => void;
}) {
  const { request } = useAiopc(props.workspaceRoot);
  const { provider } = props;
  const needsKey = provider.fields.length > 0;
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const save = async (fields: Record<string, string>) => {
    setSaving(true);
    setProblem("");
    try {
      await request("PUT", `/api/environment/providers/${provider.id}`, { body: { fields } });
      setValues({});
      props.onSaved();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-2 rounded-xl border p-3", props.chosen ? "border-primary/50 bg-primary/5" : "border-border")}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{provider.name}</span>
            {props.chosen ? <Check className="size-3.5 text-primary" /> : null}
            {provider.configured && needsKey ? (
              <span className="rounded-md bg-primary/10 px-1.5 py-px text-[11px] text-primary">{t("aiopc.environment.configured")}</span>
            ) : null}
            {!provider.available ? <span className="text-[11px] text-warning">{provider.detail}</span> : null}
          </div>
          <span className="text-xs text-muted-foreground">{provider.summary}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {needsKey ? (
            <Button variant="ghost" size="sm" onClick={props.onEdit}>
              {provider.configured ? t("aiopc.environment.change_key") : t("aiopc.environment.add_key")}
            </Button>
          ) : null}
          {!props.chosen && (provider.configured || !needsKey) ? (
            <Button variant="outline" size="sm" onClick={props.onChoose}>{t("aiopc.environment.use_this")}</Button>
          ) : null}
        </div>
      </div>
      {props.editing ? (
        <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
          <KeyFields fields={provider.fields} values={values} onChange={setValues} />
          <HelpLink text={provider.summary} url={provider.help_url} />
          {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={saving}
              onClick={() => {
                void save(values);
              }}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("aiopc.environment.save_key")}
            </Button>
            {provider.configured ? (
              <Button variant="ghost" size="sm" className="text-destructive" disabled={saving} onClick={() => void save({})}>
                {t("aiopc.environment.remove_key")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
