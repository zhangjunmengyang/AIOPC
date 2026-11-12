/** @jsxImportSource react */
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, LoaderCircle, Search } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { currentLocale, t } from "@/i18n";
import { ExtensionCard } from "@/react-app/design-system/extension-card";
import { useAiopc } from "@/react-app/domains/aiopc/aiopc-client";

type CatalogSkill = {
  id: string;
  title: string;
  source_url: string;
  commit: string;
  names: Record<string, string[]>;
  descriptions: Record<string, string[]>;
  categories: string[];
  license: string | null;
  has_scripts: boolean;
  specification: string;
  scan: string;
  snippet: string;
};

type SearchResult = { indexed: boolean; candidates: CatalogSkill[] };
type ProjectOption = { id: string; name: string };
export type CatalogAdoption = { name: string; scope: "project" | "company"; installed: boolean };

type SkillLibraryProps = {
  companyRoot: string;
  canAdopt: boolean;
  onAdopted: (adoption: CatalogAdoption) => void;
};

function catalogText(values: Record<string, string[]>) {
  return values[currentLocale()]?.[0] || values.en?.[0] || values.zh?.[0] || "";
}

function isVetted(skill: CatalogSkill) {
  return skill.specification === "passed" && skill.scan === "passed";
}

function httpsSource(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch {
    // A catalog record may lack a usable public source.
  }
  return null;
}

export function SkillLibrary(props: SkillLibraryProps) {
  const { connection, ready, request } = useAiopc(props.companyRoot);
  const titleId = useId();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<CatalogSkill | null>(null);
  const search = useQuery({
    queryKey: ["aiopc", props.companyRoot, "skillhub", "search", query],
    enabled: ready && Boolean(query),
    queryFn: () => request<SearchResult>("GET", "/api/skillhub/search", { params: { q: query } }),
    retry: false,
  });
  const trimmed = input.trim();
  return (
    <section aria-labelledby={titleId} className="grid min-w-0 gap-3">
      <h2 id={titleId} className="text-sm font-semibold text-foreground">{t("skill_library.title")}</h2>
      <form role="search" aria-label={t("skill_library.title")} className="flex min-w-0 items-center gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (!ready || !trimmed) return;
        if (trimmed === query) void search.refetch();
        else setQuery(trimmed);
      }}>
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon aria-hidden tabIndex={-1}><Search /></InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label={t("skill_library.search_label")}
            placeholder={t("skill_library.search_placeholder")}
            value={input}
            maxLength={1024}
            onChange={(event) => {
              setInput(event.target.value);
              if (!event.target.value.trim()) setQuery("");
            }}
          />
        </InputGroup>
        <Button type="submit" disabled={!ready || !trimmed || (search.isFetching && trimmed === query)}>
          {search.isFetching ? <LoaderCircle className="animate-spin" data-icon="inline-start" aria-hidden /> : null}
          {t("skill_library.search")}
        </Button>
      </form>
      {!ready && <p role="status" className="text-sm text-muted-foreground">
        {!props.companyRoot ? t("skill_library.no_company") : connection?.error || t("aiopc.service_starting")}
      </p>}
      {search.isError && <Alert variant="destructive"><AlertDescription>{search.error.message}</AlertDescription></Alert>}
      {ready && search.isSuccess && (
        <div aria-live="polite" aria-busy={search.isFetching} className="grid gap-1">
          {!search.data.indexed && <p className="text-sm text-muted-foreground">{t("skill_library.not_indexed")}</p>}
          {search.data.indexed && search.data.candidates.length === 0 && <p className="text-sm text-muted-foreground">{t("skill_library.no_results")}</p>}
          {search.data.candidates.map((skill) => (
            <ExtensionCard
              key={skill.id}
              taxonomy="skill"
              name={catalogText(skill.names) || skill.title}
              description={catalogText(skill.descriptions)}
              statusChip={isVetted(skill)
                ? { label: skill.has_scripts ? t("skill_library.scripts") : t("skill_library.vetted"), tone: "setup" }
                : { label: t("skill_library.blocked"), tone: "attention" }}
              nextActionLabel={t("skill_library.details", { name: catalogText(skill.names) || skill.title })}
              onClick={() => setDetail(skill)}
            />
          ))}
        </div>
      )}
      {detail && <SkillCatalogDetail key={detail.id} {...props} skill={detail} onClose={() => setDetail(null)} />}
    </section>
  );
}

function SkillCatalogDetail(props: SkillLibraryProps & { skill: CatalogSkill; onClose: () => void }) {
  const { skill } = props;
  const { ready, request } = useAiopc(props.companyRoot);
  const targetId = useId();
  const [target, setTarget] = useState<string | null>(null);
  const canAdopt = props.canAdopt && isVetted(skill);
  const projects = useQuery({
    queryKey: ["aiopc", props.companyRoot, "skillhub", "projects"],
    enabled: canAdopt && ready,
    queryFn: () => request<{ projects: ProjectOption[] }>("GET", "/api/projects"),
    retry: false,
  });
  const items = [
    { value: "company", label: t("skill_library.company") },
    ...(projects.data?.projects ?? []).map((project) => ({ value: project.id, label: project.name })),
  ];
  const adopt = useMutation({
    mutationFn: (value: string) => {
      const project = projects.data?.projects.find((project) => project.id === value);
      if (value !== "company" && !project) throw new Error(t("skill_library.choose_target"));
      return request<CatalogAdoption>("POST", "/api/skillhub/adopt", { body: {
        id: skill.id,
        commit: skill.commit,
        scope: project ? "project" : "company",
        ...(project ? { project: project.name } : {}),
      } });
    },
    onSuccess: props.onAdopted,
  });
  const adopted = adopt.isSuccess && adopt.variables === target;
  const description = catalogText(skill.descriptions);
  const source = httpsSource(skill.source_url);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !adopt.isPending) props.onClose(); }}>
      <DialogContent className="max-h-[min(85dvh,40rem)] gap-4 overflow-y-auto lg:max-w-lg">
        <DialogHeader className="pe-8">
          <DialogTitle className="break-words leading-normal">{catalogText(skill.names) || skill.title}</DialogTitle>
          {description && <DialogDescription className="break-words">{description}</DialogDescription>}
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {skill.license && <Badge variant="secondary" className="h-auto whitespace-normal break-all">{skill.license}</Badge>}
            {skill.categories.map((category) => <Badge key={category} variant="outline" className="h-auto whitespace-normal break-all">{category}</Badge>)}
            {isVetted(skill) && <Badge variant="outline">{t("skill_library.vetted")}</Badge>}
          </div>
          {source && <a href={source} target="_blank" rel="noreferrer" className="flex w-fit items-center gap-1.5 rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            {t("skill_library.source", { commit: skill.commit.slice(0, 8) })}<ExternalLink className="size-3.5" aria-hidden />
          </a>}
          {skill.snippet && skill.snippet !== description && <p className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-sm text-muted-foreground">{skill.snippet}</p>}
          {skill.has_scripts && <p className="text-sm text-muted-foreground">{t("skill_library.sandbox_only")}</p>}
          {!isVetted(skill) && <Alert variant="warning"><AlertDescription>
            {skill.specification !== "passed" && <p>{t("skill_library.spec_not_passed")}</p>}
            {skill.scan !== "passed" && <p>{t("skill_library.scan_not_passed")}</p>}
          </AlertDescription></Alert>}
        </div>
        {canAdopt && <form className="grid gap-2" onSubmit={(event) => {
          event.preventDefault();
          if (ready && target && !adopt.isPending && !adopted) adopt.mutate(target);
        }}>
          <label htmlFor={targetId} className="text-sm font-medium">{t("skill_library.target")}</label>
          <div className="flex min-w-0 items-center gap-2">
            <Select items={items} value={target} onValueChange={(value) => { setTarget(value); adopt.reset(); }} disabled={!ready || adopt.isPending}>
              <SelectTrigger id={targetId} className="min-w-0 flex-1">
                <SelectValue placeholder={t("skill_library.choose_target")} />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup>
              </SelectContent>
            </Select>
            <Button type="submit" disabled={!ready || !target || adopt.isPending || adopted}>{t("skill_library.adopt")}</Button>
          </div>
          {projects.isError && <p role="alert" className="text-sm text-destructive">{projects.error.message}</p>}
          {adopt.isError && <p role="alert" className="text-sm text-destructive">{adopt.error.message}</p>}
          {adopted && <p role="status" className="text-sm text-muted-foreground">{t("skill_library.adopted")}</p>}
        </form>}
      </DialogContent>
    </Dialog>
  );
}
