/** @jsxImportSource react */
import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";

import { useEnvironmentLease } from "./environment-lease";
import { useAiopcEnvironment } from "./aiopc-client";

/**
 * The project environment's screen, live. The AI works in here by itself; this
 * is for the times the person wants to watch, or has to take over — a site that
 * refuses to be automated, a password only they know.
 */
export function EnvironmentView(props: { workspaceRoot: string; environmentId: string; className?: string }) {
  const environmentQuery = useAiopcEnvironment(props.workspaceRoot, props.environmentId);
  const frame = useRef<HTMLIFrameElement>(null);
  const lease = useEnvironmentLease(props.workspaceRoot, props.environmentId);
  useEffect(() => { if (!lease.controlling) frame.current?.blur(); }, [lease.controlling]);
  const environment = environmentQuery.data ?? null;

  if (environmentQuery.isError || lease.query.isError) {
    return <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"><p className="text-sm text-destructive">{(environmentQuery.error ?? lease.query.error)?.message}</p><Button variant="outline" size="sm" onClick={() => { void environmentQuery.refetch(); void lease.query.refetch(); }}>{t("aiopc.environment.refresh")}</Button></div>;
  }
  if (!environment || !environment.running || !environment.live_view_url) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          {environmentQuery.isPending ? t("aiopc.loading") : t("aiopc.environment.not_running")}
        </p>
        {environmentQuery.isPending ? null : (
          <Button variant="outline" size="sm" onClick={() => void environmentQuery.refetch()}>
            <RefreshCw className="size-3.5" />
            {t("aiopc.environment.refresh")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className={`flex h-full min-h-0 flex-col ${props.className ?? ""}`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{t("aiopc.browser.live_view_hint")}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("aiopc.environment.refresh")}
          onClick={() => {
            if (frame.current) frame.current.src = environment.live_view_url;
          }}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 text-muted-foreground">{lease.controlling ? t("aiopc.lease.remaining", { seconds: lease.remaining }) : lease.queued ? `${lease.holder ? t("aiopc.lease.held", { name: lease.holder.label || lease.holder.sessionId || t("aiopc.lease.you") }) + " · " : ""}${t("aiopc.lease.queued", { position: lease.queued.position })}` : lease.holder ? t("aiopc.lease.held", { name: lease.holder.label || lease.holder.sessionId || t("aiopc.lease.you") }) : t("aiopc.lease.watching")}</span>
        {lease.controlling ? <><Button size="sm" variant="outline" disabled={Boolean(lease.busy)} onClick={() => void lease.renew()}>{t("aiopc.lease.continue")}</Button><Button size="sm" variant="ghost" disabled={Boolean(lease.busy)} onClick={() => void lease.release()}>{t("aiopc.lease.return")}</Button></> : lease.queued ? <Button size="sm" variant="outline" disabled={Boolean(lease.busy)} onClick={() => void lease.cancel()}>{t("aiopc.lease.cancel")}</Button> : <Button size="sm" variant="outline" disabled={Boolean(lease.busy) || !lease.query.data || lease.query.isError} onClick={() => void lease.take()}>{t("aiopc.lease.take")}</Button>}
      </div>
      {lease.controlling ? <p className="border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">{t("aiopc.lease.time_hint")}</p> : null}
      {lease.query.data?.queue.length ? <p className="border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">{t("aiopc.lease.queue")}: {lease.query.data.queue.map(item => `${item.position}. ${item.label}`).join(" · ")}</p> : null}
      {lease.problem ? <p role="alert" className="border-b border-border/60 px-3 py-2 text-xs text-destructive">{lease.problem}</p> : null}
      <div className="relative min-h-0 flex-1">
      <iframe
        key={`${props.environmentId}:${lease.query.data?.bindingRevision ?? "loading"}`}
        ref={frame}
        inert={!lease.controlling}
        tabIndex={lease.controlling ? 0 : -1}
        title={t("aiopc.browser.live_view")}
        src={environment.live_view_url}
        className="h-full w-full border-0 bg-black"
        allow={lease.controlling ? "clipboard-read; clipboard-write; autoplay" : "autoplay"}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
      />
      {!lease.controlling ? <div data-environment-watch-only className="absolute inset-0" aria-label={t("aiopc.lease.watching")} /> : null}
      </div>
    </div>
  );
}

/** The same screen, filling the app window, for when the person takes over. */
export function EnvironmentViewDialog(props: { workspaceRoot: string; environmentId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex h-[88vh] max-h-none w-[min(96vw,1480px)] max-w-none flex-col gap-0 overflow-hidden p-0 lg:max-w-none">
        <DialogHeader className="shrink-0 border-b border-border/60 px-4 py-3">
          <DialogTitle className="text-sm">{t("aiopc.browser.live_view")}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          <EnvironmentView key={`${props.workspaceRoot}:${props.environmentId}`} workspaceRoot={props.workspaceRoot} environmentId={props.environmentId} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The button the Accounts page uses to open the screen. */
export function useEnvironmentViewer(workspaceRoot: string) {
  const [target, setTarget] = useState<{ id: string; workspaceRoot: string } | null>(null);
  return {
    open: (id: string, projectRoot?: string) => setTarget({ id, workspaceRoot: projectRoot ?? workspaceRoot }),
    element: target ? <EnvironmentViewDialog workspaceRoot={target.workspaceRoot} environmentId={target.id} open onOpenChange={open => { if (!open) setTarget(null); }} /> : null,
  };
}

/** Loading state shared by the panel while the environment comes up. */
export function EnvironmentStarting() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {t("aiopc.environment.starting")}
    </div>
  );
}
