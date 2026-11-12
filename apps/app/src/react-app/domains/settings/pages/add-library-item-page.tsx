/** @jsxImportSource react */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TextInput } from "../../../design-system/text-input";
import type { CreateLibraryItemInput, LibraryAuthorableKind } from "../library";
import { LibraryPage } from "./library-page";
export const libraryFieldClass = "rounded-xl border-transparent bg-dls-hover shadow-none";
export const librarySecretFieldClass = libraryFieldClass;
export type AddLibraryItemPageProps = {
  kind: LibraryAuthorableKind; busy?: boolean; crumbs?: Array<{ label: string; onClick?: () => void }>;
  onClose: () => void; onCreate: (input: CreateLibraryItemInput) => Promise<unknown>;
};
export function AddLibraryItemPage(props: AddLibraryItemPageProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = props.kind === "skill" ? "添加技能" : props.kind === "command" ? "添加指令" : "添加员工";
  const busy = props.busy || saving;
  return <LibraryPage title={title} crumbs={props.crumbs} onBack={props.onClose} subtitle="保存在当前项目，供 AI 执行任务时使用。">
    <form className="flex max-w-2xl flex-col gap-5" onSubmit={async event => {
      event.preventDefault(); setSaving(true); setError(null);
      try { await props.onCreate({ name: name.trim(), description: description.trim(), instructions: instructions.trim() }); }
      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { setSaving(false); }
    }}>
      <label className="grid gap-2 text-sm">名称<TextInput aria-label="名称" value={name} onChange={event => setName(event.target.value)} pattern="[A-Za-z0-9_-]+" required disabled={busy} placeholder="例如 customer-research" /></label>
      <label className="grid gap-2 text-sm">说明<TextInput aria-label="说明" value={description} onChange={event => setDescription(event.target.value)} disabled={busy} /></label>
      <label className="grid gap-2 text-sm">工作内容<Textarea aria-label="工作内容" value={instructions} onChange={event => setInstructions(event.target.value)} className="min-h-64" required disabled={busy} /></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2"><Button type="submit" disabled={busy || !name.trim() || !instructions.trim()}>{saving ? "保存中…" : "保存到项目"}</Button><Button type="button" variant="ghost" onClick={props.onClose}>取消</Button></div>
    </form>
  </LibraryPage>;
}
