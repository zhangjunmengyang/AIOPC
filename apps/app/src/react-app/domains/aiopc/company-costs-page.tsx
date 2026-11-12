import type { CompanyCostReport, CompanyCostUsage } from "@openwork/types/company-costs";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { currentLocale } from "@/i18n";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const LABELS = {
  en: {
    title: "Costs", scope: "Cumulative model usage from OpenCode sessions. Costs are estimates in USD.",
    refresh: "Refresh", loading: "Reading session usage…", unavailable: "Cost data unavailable",
    retry: "Check that the session engine is ready, then refresh.",
    stale: "Refresh failed. Showing the last available report.",
    partial: "Partial results", priceMissing: "No price recorded", totalCost: "Estimated cost",
    input: "Input tokens", output: "Output tokens", reasoning: "Reasoning",
    totalInput: "Total input tokens", totalOutput: "Total output tokens",
    cacheRead: "Cache read", cacheWrite: "Cache write",
    cost: "Cost", session: "Session", role: "Role", project: "Project",
    bySession: "By session", byRole: "By role", byProject: "By project",
    companyLevel: "Company-level", unassigned: "Unassigned",
    empty: "No sessions recorded yet.", previous: "Previous page", next: "Next page",
    missingEngines: (engines: string) => `Engine unavailable (${engines}).`,
    missingSessions: (count: string) => `Sessions that could not be read: ${count}.`,
    missingPrices: (count: string) => `Usage records without a price: ${count}.`,
  },
  zh: {
    title: "成本", scope: "累计 OpenCode 会话用量，费用为美元估算。",
    refresh: "刷新", loading: "正在读取会话用量…", unavailable: "暂时读不到成本数据",
    retry: "会话引擎就绪后可刷新重试。",
    stale: "刷新失败，当前显示上次读取的数据。",
    partial: "数据不完整", priceMissing: "缺少费用记录", totalCost: "估算费用",
    input: "输入 Token", output: "输出 Token", reasoning: "推理",
    totalInput: "输入 Token 合计", totalOutput: "输出 Token 合计",
    cacheRead: "缓存读", cacheWrite: "缓存写",
    cost: "费用", session: "会话", role: "角色", project: "项目",
    bySession: "按会话", byRole: "按角色", byProject: "按项目",
    companyLevel: "公司级", unassigned: "未绑定角色",
    empty: "还没有会话。", previous: "上一页", next: "下一页",
    missingEngines: (engines: string) => `会话引擎暂不可用（${engines}）。`,
    missingSessions: (count: string) => `有 ${count} 个会话读取失败。`,
    missingPrices: (count: string) => `有 ${count} 条用量缺少费用记录。`,
  },
} as const;

type Labels = (typeof LABELS)[keyof typeof LABELS];
type CostTableRow = { id: string | null; name: string; detail?: string; usage: CompanyCostUsage };
type Formatters = { number: Intl.NumberFormat; cost: Intl.NumberFormat };
const PAGE_SIZE = 20;

function projectLabel(id: string | null, labels: Labels) {
  return id === null ? labels.companyLevel : id.slice("proj:".length);
}

function costText(usage: CompanyCostUsage, format: Formatters, labels: Labels) {
  if (usage.events > 0 && usage.unpricedEvents === usage.events) return labels.priceMissing;
  if (usage.cost > 0 && usage.cost < 0.00000001) return `< ${format.cost.format(0.00000001)}`;
  return format.cost.format(usage.cost);
}

function CostBreakdown({ rows, nameLabel, labels, format, onOpen }: {
  rows: CostTableRow[];
  nameLabel: string;
  labels: Labels;
  format: Formatters;
  onOpen?: (id: string) => void;
}) {
  const [requestedPage, setRequestedPage] = useState(0);
  if (!rows.length) return <p className="rounded-2xl border border-border px-4 py-5 text-sm text-muted-foreground">{labels.empty}</p>;
  const lastPage = Math.ceil(rows.length / PAGE_SIZE) - 1;
  const page = Math.min(requestedPage, lastPage);
  const visibleRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const number = format.number.format;
  return (
    <div className="overflow-hidden rounded-2xl border border-border">
      <Table aria-label={nameLabel} className="tabular-nums">
        <TableHeader>
          <TableRow className="bg-muted/25 hover:bg-muted/25">
            <TableHead scope="col" className="px-4">{nameLabel}</TableHead>
            <TableHead scope="col" className="text-end">{labels.input}</TableHead>
            <TableHead scope="col" className="text-end">{labels.output}</TableHead>
            <TableHead scope="col" className="pe-4 text-end">{labels.cost}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleRows.map(row => (
            <TableRow key={row.id ?? ""}>
              <TableCell className="max-w-32 whitespace-normal wrap-anywhere sm:max-w-72 sm:px-4">
                {onOpen && row.id !== null ? (
                  <button type="button" onClick={() => onOpen(row.id!)}
                    className="text-start font-medium underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                    {row.name}
                  </button>
                ) : <span className="font-medium">{row.name}</span>}
                {row.detail ? <div className="mt-0.5 text-xs text-muted-foreground">{row.detail}</div> : null}
              </TableCell>
              <TableCell className="text-end">
                {number(row.usage.input)}
                <div className="mt-0.5 text-xs text-muted-foreground">{labels.cacheRead} {number(row.usage.cacheRead)}</div>
                <div className="text-xs text-muted-foreground">{labels.cacheWrite} {number(row.usage.cacheWrite)}</div>
              </TableCell>
              <TableCell className="text-end">
                {number(row.usage.output)}
                <div className="mt-0.5 text-xs text-muted-foreground">{labels.reasoning} {number(row.usage.reasoning)}</div>
              </TableCell>
              <TableCell className="pe-4 text-end">{costText(row.usage, format, labels)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {lastPage > 0 ? (
        <div className="flex items-center justify-end gap-2 border-t border-border p-2 text-xs text-muted-foreground">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={labels.previous}
            disabled={page === 0} onClick={() => setRequestedPage(page - 1)}><ChevronLeft /></Button>
          <span>{number(page + 1)} / {number(lastPage + 1)}</span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={labels.next}
            disabled={page === lastPage} onClick={() => setRequestedPage(page + 1)}><ChevronRight /></Button>
        </div>
      ) : null}
    </div>
  );
}

export function CompanyCostsPage({ companyId, readCosts, onOpenSession }: {
  companyId: string;
  readCosts: (signal: AbortSignal) => Promise<CompanyCostReport>;
  onOpenSession: (sessionId: string) => void;
}) {
  const locale = currentLocale();
  const labels = locale === "zh" ? LABELS.zh : LABELS.en;
  const query = useQuery({
    queryKey: ["company-costs", companyId],
    queryFn: ({ signal }) => readCosts(signal),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const report = query.data;
  const sources = Object.entries(report?.sources ?? {});
  const unavailableEngines = sources.filter(([, status]) => status === "unavailable").map(([engine]) => engine);
  const hasData = report && (sources.some(([, status]) => status === "ready") || report.bySession.length > 0);
  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-7">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">{labels.title}</h1>
            <p className="text-sm text-muted-foreground">{labels.scope}</p>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
            <RefreshCw aria-hidden="true" data-icon="inline-start" />{labels.refresh}
          </Button>
        </header>
        {query.isPending ? <p role="status" className="text-sm text-muted-foreground">{labels.loading}</p> : null}
        {!query.isPending && !hasData ? (
          <Alert variant="warning">
            <AlertTitle>{labels.unavailable}</AlertTitle>
            <AlertDescription>{labels.retry}</AlertDescription>
          </Alert>
        ) : null}
        {hasData ? <CostReport key={companyId} report={report} unavailableEngines={unavailableEngines}
          stale={query.isError} labels={labels} locale={locale} onOpenSession={onOpenSession} /> : null}
      </div>
    </main>
  );
}

function CostReport({ report, unavailableEngines, stale, labels, locale, onOpenSession }: {
  report: CompanyCostReport;
  unavailableEngines: string[];
  stale: boolean;
  labels: Labels;
  locale: string;
  onOpenSession: (id: string) => void;
}) {
  const format: Formatters = {
    number: new Intl.NumberFormat(locale),
    cost: new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 8 }),
  };
  const number = format.number.format;
  const totals = report.totals;
  const notes = [
    stale ? labels.stale : null,
    unavailableEngines.length ? labels.missingEngines(unavailableEngines.join(", ")) : null,
    report.unreadableSessions ? labels.missingSessions(number(report.unreadableSessions)) : null,
    totals.unpricedEvents ? labels.missingPrices(number(totals.unpricedEvents)) : null,
  ].filter(Boolean);
  const summary = [
    [labels.totalCost, costText(totals, format, labels)],
    [labels.totalInput, number(totals.input + totals.cacheRead + totals.cacheWrite)],
    [labels.totalOutput, number(totals.output + totals.reasoning)],
  ];
  return (
    <>
      {notes.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>{labels.partial}</AlertTitle>
          <AlertDescription>{notes.join(" ")}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-3">
        {summary.map(([label, value]) => (
          <Card key={label} variant="outline" size="sm" className="gap-1 rounded-2xl">
            <CardHeader><CardTitle className="text-sm text-muted-foreground">{label}</CardTitle></CardHeader>
            <CardContent className="text-xl font-semibold tabular-nums">{value}</CardContent>
          </Card>
        ))}
      </div>
      <Tabs defaultValue="sessions">
        <TabsList aria-label={labels.title} variant="line">
          <TabsTrigger value="sessions">{labels.bySession}</TabsTrigger>
          <TabsTrigger value="roles">{labels.byRole}</TabsTrigger>
          <TabsTrigger value="projects">{labels.byProject}</TabsTrigger>
        </TabsList>
        <TabsContent value="sessions">
          <CostBreakdown nameLabel={labels.session} labels={labels} format={format} onOpen={onOpenSession}
            rows={report.bySession.map(row => ({
              id: row.id, name: row.title, usage: row.usage,
              detail: `${row.role ?? labels.unassigned} · ${projectLabel(row.projectId, labels)}`,
            }))} />
        </TabsContent>
        <TabsContent value="roles">
          <CostBreakdown nameLabel={labels.role} labels={labels} format={format}
            rows={report.byRole.map(row => ({ ...row, name: row.id ?? labels.unassigned }))} />
        </TabsContent>
        <TabsContent value="projects">
          <CostBreakdown nameLabel={labels.project} labels={labels} format={format}
            rows={report.byProject.map(row => ({ ...row, name: projectLabel(row.id, labels) }))} />
        </TabsContent>
      </Tabs>
    </>
  );
}
