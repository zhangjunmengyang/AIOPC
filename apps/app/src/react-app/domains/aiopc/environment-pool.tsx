/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cpu, Loader2, MonitorPlay, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { t } from "@/i18n";
import {
  AiopcError,
  useAiopc,
  useEnvironmentPool,
  type EnvironmentResource,
  type AiopcProjectCatalog,
  type AiopcProvider,
} from "./aiopc-client";
import { KeyFields, HelpLink } from "./connection-methods";
import { useEnvironmentViewer } from "./environment-view";

type Confirmation = {
  environment: EnvironmentResource;
  project: string;
  token: string;
  accounts: Array<{
    account_id?: string;
    name?: string;
    platform_name?: string;
  }>;
};
const problemText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const projectName = (path: string) =>
  path
    .replace(/[/\\]+$/, "")
    .split(/[/\\]/)
    .at(-1) ?? path;
const selectClass =
  "h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30";

function useEnvironmentActions(
  companyRoot: string,
  refresh: () => Promise<unknown>,
  onBound?: () => void,
) {
  const { request } = useAiopc(companyRoot);
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const act = async (
    environment: EnvironmentResource,
    action: string,
    project?: string,
    token?: string,
  ) => {
    setBusy(environment.id);
    setProblem("");
    try {
      await request(
        "POST",
        `/api/environments/${encodeURIComponent(environment.id)}`,
        {
          body: {
            action,
            ...(project ? { project } : {}),
            ...(token ? { confirmation: token } : {}),
          },
        },
      );
      setConfirmation(null);
      await refresh();
      if (action === "bind") onBound?.();
      return true;
    } catch (error) {
      if (
        error instanceof AiopcError &&
        error.data?.requires_confirmation === true &&
        typeof error.data.confirmation === "string" &&
        project
      ) {
        setConfirmation({
          environment,
          project,
          token: error.data.confirmation,
          accounts: Array.isArray(error.data.affectedAccounts)
            ? error.data.affectedAccounts
            : [],
        });
      } else setProblem(problemText(error));
      return false;
    } finally {
      setBusy("");
    }
  };
  const confirmationDialog = (
    <Dialog
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!open && !busy) setConfirmation(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("aiopc.pool.rebind_title")}</DialogTitle>
          <DialogDescription>
            {t("aiopc.pool.rebind_description", {
              name: confirmation?.environment.name ?? "",
              project: confirmation ? projectName(confirmation.project) : "",
            })}
          </DialogDescription>
        </DialogHeader>
        {confirmation?.accounts.length ? (
          <ul className="space-y-2 rounded-lg border border-border/60 p-3 text-sm">
            {confirmation.accounts.map((account, index) => (
              <li key={account.account_id ?? index}>
                {account.name ?? account.account_id}{" "}
                <span className="text-muted-foreground">
                  {account.platform_name}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("aiopc.pool.no_accounts")}
          </p>
        )}
        {problem ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => setConfirmation(null)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={Boolean(busy)}
            onClick={() => {
              if (confirmation)
                void act(
                  confirmation.environment,
                  "bind",
                  confirmation.project,
                  confirmation.token,
                );
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("aiopc.pool.confirm_rebind")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
  return { act, busy, problem, confirmationDialog };
}

function EnvironmentResourceRow(props: {
  item: EnvironmentResource;
  provider?: AiopcProvider;
  busy: boolean;
  children?: React.ReactNode;
  onWatch: () => void;
  onAct: (action: string) => void;
}) {
  const item = props.item;
  return (
    <div
      data-environment-id={item.id}
      className="flex flex-col gap-3 rounded-xl border border-border/70 p-4"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Cpu className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{item.name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {props.provider?.name ?? item.provider} ·{" "}
            {item.running
              ? t("aiopc.environment.running")
              : t("aiopc.pool.stopped")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {item.boundProject
              ? t("aiopc.pool.bound_to", {
                  project: projectName(item.boundProject),
                })
              : t("aiopc.pool.unbound")}
            {!item.boundProject && item.lastProject
              ? ` · ${t("aiopc.pool.last_project", { project: projectName(item.lastProject) })}`
              : ""}
          </p>
        </div>
        {props.busy ? (
          <Loader2 className="size-4 shrink-0 animate-spin" />
        ) : null}
      </div>
      {item.detail ? (
        <p className="text-xs text-muted-foreground">{item.detail}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {item.running ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!item.live_view_url}
              onClick={props.onWatch}
            >
              <MonitorPlay className="size-3.5" />
              {t("aiopc.environment.watch")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={props.busy}
              onClick={() => props.onAct("stop")}
            >
              {t("aiopc.environment.stop")}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={props.busy || props.provider?.available === false}
            onClick={() => props.onAct("start")}
          >
            {t("aiopc.environment.start")}
          </Button>
        )}
        {props.children}
      </div>
    </div>
  );
}

/** All environments belong to the company. A project can bind any number of them. */
export function EnvironmentPoolView(props: {
  companyRoot: string;
  projectRoot?: string;
  onBound?: () => void;
}) {
  const { connection, ready, request } = useAiopc(props.companyRoot);
  const pool = useEnvironmentPool(props.companyRoot);
  const viewer = useEnvironmentViewer(props.projectRoot ?? props.companyRoot);
  const projects = useQuery({
    queryKey: ["aiopc", props.companyRoot, "projects"],
    enabled: ready && !props.projectRoot,
    queryFn: () => request<AiopcProjectCatalog>("GET", "/api/projects"),
    retry: false,
  });
  const actions = useEnvironmentActions(
    props.companyRoot,
    () => pool.refetch(),
    props.onBound,
  );
  const [creating, setCreating] = useState(false);
  const [destroying, setDestroying] = useState<EnvironmentResource | null>(
    null,
  );
  const [installing, setInstalling] = useState(false);
  const [installProblem, setInstallProblem] = useState("");
  const missingLocalEngine = pool.data?.providers.find(
    (provider) => provider.id === "local" && !provider.available,
  );
  const installEngine = async () => {
    setInstalling(true);
    setInstallProblem("");
    try {
      await request("POST", "/api/environment", {
        body: { action: "install-engine" },
      });
      await pool.refetch();
    } catch (error) {
      setInstallProblem(problemText(error));
    } finally {
      setInstalling(false);
    }
  };
  const bind = async (item: EnvironmentResource, project: string) => {
    await actions.act(item, "bind", project);
  };
  return (
    <section aria-label={t("aiopc.pool.title")} className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">{t("aiopc.pool.title")}</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            {t("aiopc.pool.description")}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!ready}
          onClick={() => setCreating(true)}
        >
          <Plus className="size-3.5" />
          {t("aiopc.pool.create")}
        </Button>
      </header>
      {missingLocalEngine ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/50 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 text-muted-foreground">
            {missingLocalEngine.detail || t("aiopc.environment.needs_engine")}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={installing}
            onClick={() => void installEngine()}
          >
            {installing ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("aiopc.environment.install_engine")}
          </Button>
        </div>
      ) : null}
      {installProblem ? (
        <p role="alert" className="text-sm text-destructive">
          {installProblem}
        </p>
      ) : null}
      {!connection || connection.status !== "ready" ? (
        <p className="text-sm text-muted-foreground">
          {connection?.error || t("aiopc.loading")}
        </p>
      ) : pool.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("aiopc.loading")}
        </p>
      ) : pool.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemText(pool.error)}
        </p>
      ) : pool.data?.items.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          {t("aiopc.pool.empty")}
        </p>
      ) : (
        <div className="space-y-3">
          {pool.data?.items.map((item) => (
            <EnvironmentResourceRow
              key={item.id}
              item={item}
              provider={pool.data.providers.find(
                (provider) => provider.id === item.provider,
              )}
              busy={actions.busy === item.id}
              onWatch={() =>
                viewer.open(item.id, item.boundProject ?? undefined)
              }
              onAct={(action) => void actions.act(item, action)}
            >
              {props.projectRoot ? (
                item.boundProject === props.projectRoot ? (
                  <span className="text-xs text-muted-foreground">
                    {t("aiopc.pool.already_bound")}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    disabled={Boolean(actions.busy)}
                    onClick={() => void bind(item, props.projectRoot!)}
                  >
                    {t("aiopc.pool.bind_here")}
                  </Button>
                )
              ) : (
                <>
                  <select
                    aria-label={t("aiopc.pool.bind_select", {
                      name: item.name,
                    })}
                    className={selectClass}
                    value={item.boundProject ?? ""}
                    disabled={
                      Boolean(actions.busy) ||
                      projects.isPending ||
                      projects.isError
                    }
                    onChange={(event) => {
                      if (event.target.value)
                        void bind(item, event.target.value);
                      else void actions.act(item, "unbind");
                    }}
                  >
                    <option value="">{t("aiopc.pool.unbound")}</option>
                    {item.boundProject &&
                    !projects.data?.projects.some(
                      (project) => project.path === item.boundProject,
                    ) ? (
                      <option value={item.boundProject}>
                        {projectName(item.boundProject)}
                      </option>
                    ) : null}
                    {projects.data?.projects.map((project) => (
                      <option key={project.id} value={project.path}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-destructive"
                    disabled={Boolean(actions.busy)}
                    onClick={() => setDestroying(item)}
                  >
                    {t("aiopc.pool.destroy")}
                  </Button>
                </>
              )}
            </EnvironmentResourceRow>
          ))}
        </div>
      )}
      {projects.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemText(projects.error)}
        </p>
      ) : null}
      {actions.problem ? (
        <p role="alert" className="text-sm text-destructive">
          {actions.problem}
        </p>
      ) : null}
      {actions.confirmationDialog}
      {viewer.element}
      <CreateEnvironmentDialog
        open={creating}
        onOpenChange={setCreating}
        companyRoot={props.companyRoot}
        providers={pool.data?.providers ?? []}
        onCreated={() => void pool.refetch()}
      />
      <ConfirmModal
        open={destroying !== null}
        title={t("aiopc.pool.destroy")}
        message={t("aiopc.pool.destroy_confirm", {
          name: destroying?.name ?? "",
        })}
        confirmLabel={t("aiopc.pool.destroy")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onCancel={() => {
          if (!actions.busy) setDestroying(null);
        }}
        onConfirm={() => {
          if (destroying)
            void actions.act(destroying, "destroy").then((ok) => {
              if (ok) setDestroying(null);
            });
        }}
      />
    </section>
  );
}

export function ProjectEnvironments(props: {
  companyRoot: string;
  projectRoot: string;
}) {
  const pool = useEnvironmentPool(props.companyRoot);
  const [adding, setAdding] = useState(false);
  const viewer = useEnvironmentViewer(props.projectRoot);
  const actions = useEnvironmentActions(props.companyRoot, () =>
    pool.refetch(),
  );
  const items =
    pool.data?.items.filter(
      (item) => item.boundProject === props.projectRoot,
    ) ?? [];
  return (
    <section
      className="space-y-3"
      aria-label={t("aiopc.projects.environments")}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">
          {t("aiopc.projects.environments")}
        </h2>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus className="size-3.5" />
          {t("aiopc.pool.add")}
        </Button>
      </div>
      {pool.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("aiopc.loading")}
        </p>
      ) : pool.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemText(pool.error)}
        </p>
      ) : items.length ? (
        <div className="space-y-3">
          {items.map((item) => (
            <EnvironmentResourceRow
              key={item.id}
              item={item}
              provider={pool.data?.providers.find(
                (provider) => provider.id === item.provider,
              )}
              busy={actions.busy === item.id}
              onWatch={() =>
                viewer.open(item.id, item.boundProject ?? undefined)
              }
              onAct={(action) => void actions.act(item, action)}
            >
              <Button
                size="sm"
                variant="ghost"
                disabled={Boolean(actions.busy)}
                onClick={() => void actions.act(item, "unbind")}
              >
                {t("aiopc.pool.unbind")}
              </Button>
            </EnvironmentResourceRow>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("aiopc.projects.environments_empty")}
        </p>
      )}
      {actions.problem ? (
        <p role="alert" className="text-sm text-destructive">
          {actions.problem}
        </p>
      ) : null}
      {actions.confirmationDialog}
      {viewer.element}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("aiopc.pool.add")}</DialogTitle>
            <DialogDescription>{t("aiopc.pool.add_hint")}</DialogDescription>
          </DialogHeader>
          <EnvironmentPoolView
            companyRoot={props.companyRoot}
            projectRoot={props.projectRoot}
            onBound={() => setAdding(false)}
          />
        </DialogContent>
      </Dialog>
    </section>
  );
}

function CreateEnvironmentDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyRoot: string;
  providers: AiopcProvider[];
  onCreated: () => void;
}) {
  const { request } = useAiopc(props.companyRoot);
  const [name, setName] = useState("");
  const [providerId, setProviderId] = useState("local");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    if (!props.open) {
      setFields({});
      setProblem("");
      setName("");
    }
  }, [props.open, props.companyRoot]);
  const provider = props.providers.find((item) => item.id === providerId);
  const create = async () => {
    setBusy(true);
    setProblem("");
    try {
      await request("POST", "/api/environments", {
        body: { name: name.trim(), provider: providerId, fields },
      });
      setName("");
      setFields({});
      props.onCreated();
      props.onOpenChange(false);
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!busy) props.onOpenChange(open);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("aiopc.pool.create")}</DialogTitle>
          <DialogDescription>{t("aiopc.pool.create_hint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label className="block space-y-1.5 text-sm">
            <span>{t("aiopc.pool.name")}</span>
            <Input
              name="environmentName"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>{t("aiopc.pool.provider")}</span>
            <select
              aria-label={t("aiopc.pool.provider")}
              className={`${selectClass} w-full`}
              value={providerId}
              onChange={(event) => {
                setProviderId(event.target.value);
                setFields({});
              }}
            >
              {props.providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {provider ? (
            <>
              <HelpLink text={provider.summary} url={provider.help_url} />
              <KeyFields
                fields={provider.fields}
                values={fields}
                onChange={setFields}
              />
            </>
          ) : null}
          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button disabled={busy || !name.trim() || !provider} type="submit">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("aiopc.pool.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
