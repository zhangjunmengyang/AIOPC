/** @jsxImportSource react */
import { Loader2, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";

import { useAiopcEnvironment } from "./aiopc-client";

/**
 * The project environment's screen, live. The AI works in here by itself; this
 * is for the times the person wants to watch, or has to take over — a site that
 * refuses to be automated, a password only they know.
 */
export function EnvironmentView(props: { workspaceRoot: string; className?: string }) {
  const environmentQuery = useAiopcEnvironment(props.workspaceRoot);
  const frame = useRef<HTMLIFrameElement>(null);
  const environment = environmentQuery.data ?? null;

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
      <iframe
        ref={frame}
        title={t("aiopc.browser.live_view")}
        src={environment.live_view_url}
        className="min-h-0 w-full flex-1 border-0 bg-black"
        allow="clipboard-read; clipboard-write; autoplay; microphone"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
      />
    </div>
  );
}

/** The same screen, filling the app window, for when the person takes over. */
export function EnvironmentViewDialog(props: { workspaceRoot: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex h-[88vh] max-h-none w-[min(96vw,1480px)] max-w-none flex-col gap-0 overflow-hidden p-0 lg:max-w-none">
        <DialogHeader className="shrink-0 border-b border-border/60 px-4 py-3">
          <DialogTitle className="text-sm">{t("aiopc.browser.live_view")}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          <EnvironmentView workspaceRoot={props.workspaceRoot} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The button the Accounts page uses to open the screen. */
export function useEnvironmentViewer(workspaceRoot: string) {
  const [open, setOpen] = useState(false);
  return {
    open: () => setOpen(true),
    element: <EnvironmentViewDialog workspaceRoot={workspaceRoot} open={open} onOpenChange={setOpen} />,
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
