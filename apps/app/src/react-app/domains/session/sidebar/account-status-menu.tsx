import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, MessageCircleMore, Settings, MoreHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { usePlatform } from "../../../kernel/platform";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";
import { useShellConfig } from "../../../shell/shell-config";
import type { OpenworkServerStatus } from "@/app/lib/openwork-server";
const BOOT_STARTED_AT = Date.now();
const INITIALIZING_MS = 15_000;
type StatusDotVariant = "connected" | "loading" | "partial" | "disconnected";

function StatusDot({ variant }: { variant: StatusDotVariant }) {
  return (
    <span className="relative flex size-2 shrink-0 items-center justify-center">
      {variant === "loading" ? (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-9/35" />
      ) : null}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          variant === "connected" && "bg-green-9",
          variant === "loading" && "bg-amber-9",
          variant === "partial" && "bg-amber-9",
          variant === "disconnected" && "bg-red-9",
        )}
      />
    </span>
  );
}

type RuntimeStatus = {
  variant: StatusDotVariant;
  label: string;
  detail: string | null;
};

type RuntimeStatusInput = {
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  initializing: boolean;
  reloadBusy?: boolean;
  reloadError?: string | null;
};

export function resolveRuntimeStatus(input: RuntimeStatusInput): RuntimeStatus {
  if (input.reloadBusy) {
    return {
      variant: "loading",
      label: t("status.reloading_config"),
      detail: t("config.reload_now_desc"),
    };
  }
  if (input.reloadError) {
    return { variant: "disconnected", label: t("system.reload_failed"), detail: input.reloadError };
  }
  // This row renders app-scoped facts only. Per-session loading (messages
  // still fetching, a model verdict still pending) stays in the pane and the
  // composer — one session's state must not paint the whole app as booting.
  if (input.openworkServerStatus === "disconnected" && input.initializing) {
    return {
      variant: "loading",
      label: t("session.preparing_workspace"),
      detail: t("session.loading_detail"),
    };
  }
  if (input.clientConnected) {
    return { variant: "connected", label: t("status.ready_for_tasks"), detail: null };
  }
  if (input.openworkServerStatus === "limited") {
    return { variant: "partial", label: t("status.limited_mode"), detail: t("status.limited_hint") };
  }
  return {
    variant: "disconnected",
    label: t("status.disconnected_label"),
    detail: t("status.disconnected_hint"),
  };
}

export type AccountStatusMenuProps = {
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  developerMode: boolean;
  /** Hidden until a workspace is selected, matching the old status bar. */
  showConnectionStatus: boolean;
  providerConnectedIds: string[];
  mcpConnectedCount: number;
  reloadBusy?: boolean;
  reloadError?: string | null;
  showSettingsButton?: boolean;
  onOpenAccountSettings?: () => void;
  onSendFeedback?: () => void;
};


export function AccountStatusMenu(props: AccountStatusMenuProps) {
  const platform = usePlatform();
  const { config } = useShellConfig();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [initializing, setInitializing] = useState(() => Date.now() - BOOT_STARTED_AT < INITIALIZING_MS);
  useEffect(() => {
    const timeout = window.setTimeout(() => setInitializing(false), Math.max(0, INITIALIZING_MS - (Date.now() - BOOT_STARTED_AT)));
    return () => window.clearTimeout(timeout);
  }, []);
  const runtime = resolveRuntimeStatus({ ...props, initializing });
  const openDocs = () => platform.openLink("https://github.com/zhangjunmengyang/AIOPC#readme");
  const action = useMemo<OpenworkControlAction>(() => ({ id: "status.settings.open", label: "打开设置", description: "打开本地应用设置。",
    sideEffect: "navigation", targetRef: triggerRef, execute: () => props.onOpenAccountSettings?.() }), [props.onOpenAccountSettings]);
  useControlAction(action);
  return <DropdownMenu>
    <DropdownMenuTrigger render={<button ref={triggerRef} type="button" data-testid="account-status-menu" data-runtime-state={runtime.variant}
      aria-label="AIOPC 状态与设置" title={runtime.detail ?? runtime.label}
      className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-sidebar-accent max-lg:min-h-11">
      <img src="/aiopc-mark.svg" alt="" className="size-6 dark:invert" />
      <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">AIOPC</span>
        <span className="block truncate text-[10.5px] text-muted-foreground">{runtime.label}</span></span>
      <StatusDot variant={runtime.variant} /><MoreHorizontal size={14} />
    </button>} />
    <DropdownMenuContent side="top" align="start" className="w-64">
      <div className="px-2 py-1.5 text-xs text-muted-foreground">{runtime.detail ?? runtime.label}</div>
      <DropdownMenuSeparator />
      {props.showSettingsButton !== false ? <DropdownMenuItem onClick={props.onOpenAccountSettings}><Settings className="size-3.5" />{t("status.settings")}</DropdownMenuItem> : null}
      {config.docsButton ? <DropdownMenuItem onClick={openDocs}><BookOpen className="size-3.5" />{t("status.docs")}</DropdownMenuItem> : null}
      {config.feedbackButton && props.onSendFeedback ? <DropdownMenuItem onClick={props.onSendFeedback}><MessageCircleMore className="size-3.5" />{t("status.feedback")}</DropdownMenuItem> : null}
    </DropdownMenuContent>
  </DropdownMenu>;
}
