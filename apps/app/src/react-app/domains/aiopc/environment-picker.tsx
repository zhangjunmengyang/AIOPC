/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import {
  useProjectEnvironments,
  type EnvironmentResource,
} from "./aiopc-client";

export function EnvironmentPicker(props: {
  projectRoot: string;
  onClose: () => void;
  onSelect: (environment: EnvironmentResource) => void;
}) {
  const { project, pool, items } = useProjectEnvironments(props.projectRoot);
  const selected = useRef(false);
  useEffect(() => {
    if (!selected.current && items.length === 1) {
      selected.current = true;
      props.onSelect(items[0]!);
    }
  }, [items, props.onSelect]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("aiopc.pool.select")}</DialogTitle>
          <DialogDescription>{t("aiopc.pool.select_hint")}</DialogDescription>
        </DialogHeader>
        {project.isError || pool.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {String((project.error ?? pool.error)?.message)}
          </p>
        ) : project.isPending || pool.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("aiopc.loading")}
          </p>
        ) : items.length ? (
          <div className="space-y-2">
            {items.map((item) => (
              <Button
                key={item.id}
                variant="outline"
                className="h-auto w-full justify-between py-3"
                onClick={() => props.onSelect(item)}
              >
                <span>{item.name}</span>
                <span className="text-xs text-muted-foreground">
                  {item.running
                    ? t("aiopc.environment.running")
                    : t("aiopc.pool.stopped")}
                </span>
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("aiopc.pool.select_empty")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
