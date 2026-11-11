/** @jsxImportSource react */
import { Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";

import { type AiopcProject, useAiopc } from "./aiopc-client";

/** Which project a page shows: the lab or one product. New projects need only a name. */
export function ProjectSwitcher(props: {
  workspaceRoot: string;
  projects: AiopcProject[];
  value: string;
  onChange: (projectId: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const items = props.projects.map((project) => ({ value: project.id, label: project.name }));
  return (
    <div className="flex items-center gap-1.5">
      <Select value={props.value} items={items} onValueChange={(value) => { if (value) props.onChange(String(value)); }}>
        <SelectTrigger className="w-52" aria-label={t("aiopc.project")}>
          <SelectValue placeholder={t("aiopc.project")} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {props.projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Button variant="outline" size="icon-sm" aria-label={t("aiopc.new_project")} title={t("aiopc.new_project")} onClick={() => setCreating(true)}>
        <Plus className="size-4" />
      </Button>
      <NewProjectDialog
        open={creating}
        workspaceRoot={props.workspaceRoot}
        onOpenChange={setCreating}
        onCreated={(project) => props.onChange(project.id)}
      />
    </div>
  );
}

function NewProjectDialog(props: {
  open: boolean;
  workspaceRoot: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: AiopcProject) => void;
}) {
  const { request, invalidate } = useAiopc(props.workspaceRoot);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const project = await request<AiopcProject>("POST", "/api/projects", { body: { name: name.trim(), description: description.trim() } });
      await invalidate("projects");
      props.onCreated(project);
      props.onOpenChange(false);
      setName("");
      setDescription("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="w-full max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("aiopc.new_project")}</DialogTitle>
          <DialogDescription>{t("aiopc.new_project_hint")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && !busy) void submit();
          }}
        >
          <Input autoFocus value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder={t("aiopc.project_name")} maxLength={120} />
          <Textarea value={description} onChange={(event) => setDescription(event.currentTarget.value)} placeholder={t("aiopc.project_description")} rows={3} />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={!name.trim() || busy}>{busy ? t("aiopc.creating") : t("aiopc.create")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
