/** @jsxImportSource react */
import { AlertTriangle, LoaderCircle } from "lucide-react";

import { t } from "@/i18n";

import type { AiopcConnection } from "./aiopc-client";

/** Shown while the OPC service starts, or when it cannot run here. */
export function AiopcUnavailable(props: { connection: AiopcConnection | null; title: string }) {
  const starting = !props.connection || props.connection.status === "starting" || props.connection.status === "stopped";
  return (
    <section aria-label={props.title} className="flex h-full min-h-0 items-center justify-center px-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {starting ? <LoaderCircle className="size-6 animate-spin text-muted-foreground" /> : <AlertTriangle className="size-6 text-warning" />}
        <h1 className="text-base font-medium">{starting ? t("aiopc.service_starting") : t("aiopc.service_unavailable")}</h1>
        <p className="text-sm text-muted-foreground">
          {starting ? t("aiopc.service_starting_hint") : props.connection?.error || t("aiopc.service_unavailable_hint")}
        </p>
      </div>
    </section>
  );
}
