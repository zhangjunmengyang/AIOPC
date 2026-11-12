/** @jsxImportSource react */
import { Network, Pencil } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import "./company-org-chart.css";

export type CompanyOrgRole = { id: string; name: string; description?: string; reportsTo: string | null };
export type CompanyOrgSnapshot = { roles: CompanyOrgRole[] };

type OrgNode = { role: CompanyOrgRole; children: OrgNode[] };

export function buildCompanyOrgChart(roles: CompanyOrgRole[]): OrgNode[] {
  const ids = new Set(roles.map((role) => role.id));
  const reports = new Map<string, CompanyOrgRole[]>();
  const roots: CompanyOrgRole[] = [];
  for (const role of roles) {
    if (role.reportsTo === null || !ids.has(role.reportsTo)) {
      roots.push(role);
    } else {
      const peers = reports.get(role.reportsTo) ?? [];
      peers.push(role);
      reports.set(role.reportsTo, peers);
    }
  }

  const visited = new Set<string>();
  function visit(role: CompanyOrgRole): OrgNode {
    visited.add(role.id);
    const children: OrgNode[] = [];
    for (const report of reports.get(role.id) ?? []) {
      if (!visited.has(report.id)) children.push(visit(report));
    }
    return { role, children };
  }

  const chart = roots.map(visit);
  // Keep manually edited, cyclic data visible so its owner can repair it.
  for (const role of roles) {
    if (!visited.has(role.id)) chart.push(visit(role));
  }
  return chart;
}

export function reportingLineOptions(roles: CompanyOrgRole[], roleId: string): CompanyOrgRole[] {
  const managers = new Map(roles.map((role) => [role.id, role.reportsTo]));
  return roles.filter(({ id }) => {
    const seen = new Set([roleId]);
    let manager: string | null = id;
    while (manager !== null) {
      if (seen.has(manager)) return false;
      seen.add(manager);
      manager = managers.get(manager) ?? null;
    }
    return true;
  });
}

function OrgRoleNode({ node, onEdit }: { node: OrgNode; onEdit?: (role: CompanyOrgRole) => void }) {
  const { role, children } = node;
  const cardClass = "flex min-h-13 w-full items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 text-start text-card-foreground sm:w-49";
  const details = (
    <>
      <Avatar size="sm" aria-hidden="true"><AvatarFallback>{Array.from(role.name)[0]}</AvatarFallback></Avatar>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium" title={role.name}>{role.name}</span>
        {role.description && <span className="block truncate text-xs text-muted-foreground" title={role.description}>{role.description}</span>}
      </span>
    </>
  );
  return (
    <li data-org-role={role.id} className="company-org-node">
      {onEdit ? (
        <button
          type="button"
          aria-label={t("aiopc.org.edit_for", { name: role.name })}
          className={cardClass + " cursor-pointer transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"}
          onClick={() => onEdit(role)}
        >
          {details}
          <Pencil aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      ) : <div className={cardClass}>{details}</div>}
      {children.length > 0 && (
        <ul className="company-org-children">
          {children.map((child) => <OrgRoleNode key={child.role.id} node={child} onEdit={onEdit} />)}
        </ul>
      )}
    </li>
  );
}

function ReportingLineDialog({ role, roles, close, save }: {
  role: CompanyOrgRole;
  roles: CompanyOrgRole[];
  close: () => void;
  save: (id: string, reportsTo: string | null) => Promise<void>;
}) {
  const options = useMemo(() => reportingLineOptions(roles, role.id), [roles, role.id]);
  const managerIsAvailable = options.some((option) => option.id === role.reportsTo);
  const initialChoice = managerIsAvailable ? (role.reportsTo ?? "") : "";
  const [choice, setChoice] = useState(initialChoice);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const directReports = roles.filter((report) => report.reportsTo === role.id && report.id !== role.id);
  const changed = (choice || null) !== role.reportsTo;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || saving) return;
    setSaving(true);
    setError("");
    try {
      await save(role.id, choice || null);
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("aiopc.org.save_error"));
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) close(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{role.name}</DialogTitle>
          <DialogDescription>{role.description || t("aiopc.org.edit_for", { name: role.name })}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="company-org-manager">{t("aiopc.org.reports_to")}</Label>
            <Select
              items={[{ value: "", label: t("aiopc.org.no_manager") }, ...options.map(({ id, name }) => ({ value: id, label: name }))]}
              value={choice}
              onValueChange={(value) => setChoice(value ?? "")}
              disabled={saving}
            >
              <SelectTrigger id="company-org-manager" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="">{t("aiopc.org.no_manager")}</SelectItem>
                {options.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {role.reportsTo !== null && !managerIsAvailable && (
              <p className="text-xs text-muted-foreground">{t("aiopc.org.invalid_manager", { id: role.reportsTo })}</p>
            )}
          </div>
          <div className="grid gap-1">
            <span className="text-sm font-medium">{t("aiopc.org.direct_reports")}</span>
            <p className="text-sm text-muted-foreground">
              {directReports.length > 0 ? directReports.map((report) => report.name).join(" · ") : t("aiopc.org.no_direct_reports")}
            </p>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" type="button" disabled={saving} onClick={close}>{t("aiopc.org.cancel")}</Button>
            <Button type="submit" disabled={!changed || saving}>{t(saving ? "aiopc.org.saving" : "aiopc.org.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CompanyOrgPage({ loadOrgChart, updateReportingLine, readOnly }: {
  loadOrgChart: () => Promise<CompanyOrgSnapshot>;
  updateReportingLine: (roleId: string, reportsTo: string | null) => Promise<CompanyOrgSnapshot>;
  readOnly?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<CompanyOrgSnapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadOrgChart().then((data) => {
      if (active) setSnapshot(data);
    }, (error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : t("aiopc.org.load_error"));
    });
    return () => { active = false; };
  }, [loadOrgChart, reload]);

  const chart = useMemo(() => buildCompanyOrgChart(snapshot?.roles ?? []), [snapshot]);
  const editingRole = snapshot?.roles.find((role) => role.id === editingId);
  const edit = readOnly ? undefined : (role: CompanyOrgRole) => setEditingId(role.id);

  return (
    <section data-aiopc-company-org aria-label={t("aiopc.org.title")} className="h-full min-w-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 pb-12 pt-8 sm:px-6">
        <h1 className="text-xl font-semibold tracking-tight">{t("aiopc.org.title")}</h1>
        {loadError ? (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-sm text-destructive">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => { setLoadError(""); setReload(reload + 1); }}>{t("aiopc.org.retry")}</Button>
          </div>
        ) : snapshot === null ? (
          <p role="status" className="text-sm text-muted-foreground">{t("aiopc.loading")}</p>
        ) : chart.length === 0 ? (
          <Empty><EmptyHeader><EmptyMedia variant="icon"><Network aria-hidden="true" /></EmptyMedia><EmptyTitle>{t("aiopc.org.empty")}</EmptyTitle></EmptyHeader></Empty>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border bg-muted/20 p-4 sm:p-6">
            <ul className="company-org-roots">
              {chart.map((node) => <OrgRoleNode key={node.role.id} node={node} onEdit={edit} />)}
            </ul>
          </div>
        )}
      </div>
      {!readOnly && editingRole && snapshot && (
        <ReportingLineDialog
          key={editingRole.id}
          role={editingRole}
          roles={snapshot.roles}
          close={() => setEditingId(null)}
          save={async (id, reportsTo) => setSnapshot(await updateReportingLine(id, reportsTo))}
        />
      )}
    </section>
  );
}
