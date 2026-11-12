/** @jsxImportSource react */
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ChevronRight, Inbox, MessageCircleQuestion, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { z } from "zod";

import { unwrap } from "@/app/lib/opencode";
import { isOpencodeV2Client } from "@/app/lib/opencode-v2-adapter";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { Client, PendingPermission } from "@/app/types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { currentLocale, t } from "@/i18n";
import { useWorkspaceMaybe } from "@/react-app/shell/workspace-provider";

import { PermissionApprovalPanel } from "../session/chat/permission-approval-modal";
import { QuestionPanel } from "../session/modals/question-modal";
import { isReservedConnectionQuestion } from "../session/surface/mcp-chat-reconnect";
import { settlePermissionState, settleQuestionState } from "../session/sync/session-sync";
import { useAiopc } from "./aiopc-client";
import { publishReviewSchema, SavedPublishReviewCard } from "./publish-review-card";

type Props = {
  workspaceRoot?: string | null;
  workspaceId?: string;
  client?: Client | null;
  openworkServerClient?: OpenworkServerClient | null;
  openSession: (sessionId: string) => void;
};

type RoutineResult = {
  id: string;
  name: string;
  projectRoot: string;
  status: "succeeded" | "failed";
  result: string | null;
  error: string | null;
  finishedAt: number | null;
};

function folderName(path: string) {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
}

function OpenSession({ open }: { open: () => void }) {
  return (
    <Button type="button" size="sm" variant="ghost" onClick={open}>
      {t("aiopc.inbox.open_conversation")}
      <ArrowUpRight data-icon="inline-end" />
    </Button>
  );
}

function PendingRow({ title, detail, icon, children }: { title: string; detail: string; icon: ReactNode; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  return (
    <details className="group rounded-xl border border-border bg-card" onToggle={event => { if (event.currentTarget.open) setOpened(true); }}>
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&>svg]:size-4" aria-hidden>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">{detail}</span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground group-open:rotate-90" aria-hidden />
      </summary>
      {opened ? <div className="space-y-2 border-t border-border p-3">{children}</div> : null}
    </details>
  );
}

export function InboxResults({ items }: { items: RoutineResult[] }) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
      {items.map(item => {
        const timestamp = item.finishedAt === null ? null : new Date(item.finishedAt);
        return (
          <li key={item.id} className="space-y-2 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="break-words text-sm font-medium">{item.name}</h2>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{folderName(item.projectRoot)}</span>
                  {timestamp ? <time dateTime={timestamp.toISOString()}>{timestamp.toLocaleString(currentLocale())}</time> : null}
                </div>
              </div>
              <span className={item.status === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                {t(`aiopc.inbox.routine_${item.status}`)}
              </span>
            </div>
            {item.error ? <p className="whitespace-pre-wrap break-words text-sm text-destructive">{item.error}</p> : null}
            {item.result ? <p className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-sm">{item.result}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function InboxPage(props: Props) {
  const workspace = useWorkspaceMaybe();
  const workspaceRoot = props.workspaceRoot ?? workspace?.selectedWorkspaceRoot ?? "";
  const workspaceId = props.workspaceId ?? workspace?.workspaceId ?? "";
  const client = props.client === undefined ? workspace?.client : props.client;
  const host = props.openworkServerClient === undefined ? workspace?.openworkServerClient : props.openworkServerClient;
  const { connection, ready, request } = useAiopc(workspaceRoot);
  const [tab, setTab] = useState("pending");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const directory = workspaceRoot || undefined;
  const native = client && isOpencodeV2Client(client);
  const scope = ["aiopc", workspaceRoot, "inbox", workspaceId, native ? "v2" : "v1"];
  const refetchInterval = 15_000;

  const permissions = useQuery({
    queryKey: [...scope, "permission"], enabled: Boolean(client && workspaceRoot), refetchInterval,
    queryFn: async ({ signal }) => {
      if (!client) return [];
      const items = unwrap(await (isOpencodeV2Client(client)
        ? client.listWorkspacePermissions({ signal }) : client.permission.list({ directory }, { signal })));
      return items.map((permission): PendingPermission => ({ ...permission, receivedAt: 0, protocol: native ? "v2" : "legacy" }));
    },
  });
  const questions = useQuery({
    queryKey: [...scope, "question"], enabled: Boolean(client && workspaceRoot), refetchInterval,
    queryFn: async ({ signal }) => client ? unwrap(await client.question.list({ directory }, { signal })) : [],
  });
  const reviews = useQuery({
    queryKey: ["aiopc", workspaceRoot, "publish-reviews"], enabled: ready, refetchInterval, retry: false,
    queryFn: async () => z.object({ items: z.array(publishReviewSchema) }).parse(await request("GET", "/api/publish-reviews")).items,
  });
  const receipts = useQuery({
    queryKey: ["aiopc", workspaceRoot, "routine-results"], enabled: ready, refetchInterval, retry: false,
    queryFn: async () => (await request<{ items: RoutineResult[] }>("GET", "/api/routine-results")).items,
  });

  async function act(id: string, action: () => Promise<unknown>, refresh: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(id);
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("app.error_request_failed"));
    } finally {
      await refresh();
      setBusy(null);
      inFlight.current = false;
    }
  }

  const pending = (reviews.data ?? []).filter(review => review.status === "awaiting_approval" || review.status === "filling");
  const handled = (reviews.data ?? []).filter(review => review.status !== "awaiting_approval" && review.status !== "filling");
  const pendingCount = pending.length + (permissions.data?.length ?? 0) + (questions.data?.length ?? 0);
  const loadError = connection?.status === "unavailable"
    || (tab === "pending" ? permissions.error ?? questions.error ?? reviews.error : receipts.error ?? reviews.error);
  const loading = tab === "pending" ? permissions.isLoading || questions.isLoading || reviews.isLoading : receipts.isLoading || reviews.isLoading;
  const pendingReady = Boolean(client && workspaceRoot && ready && !loading && !loadError);
  const resultsReady = ready && !loading && !loadError;

  const refreshAll = () => {
    if (client && workspaceRoot) { void permissions.refetch(); void questions.refetch(); }
    if (ready) { void reviews.refetch(); void receipts.refetch(); }
  };

  return (
    <main className="h-full min-h-0 overflow-y-auto px-4 py-5 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold tracking-tight">{t("aiopc.inbox.title")}</h1>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("aiopc.inbox.refresh")} onClick={refreshAll} disabled={loading}>
            <RefreshCw aria-hidden />
          </Button>
        </header>
        <Tabs value={tab} onValueChange={value => setTab(value === "results" ? value : "pending")}>
          <TabsList>
            <TabsTrigger value="pending">{t("aiopc.inbox.pending")}{pendingCount > 0 ? <span className="ml-1 tabular-nums">{pendingCount}</span> : null}</TabsTrigger>
            <TabsTrigger value="results">{t("aiopc.inbox.results")}</TabsTrigger>
          </TabsList>
          {loadError || actionError ? <p role="alert" className="mt-3 break-words text-sm text-destructive">{actionError ?? t("aiopc.inbox.load_error")}</p> : null}
          {loading || (!ready && !loadError) ? <p role="status" className="mt-3 text-sm text-muted-foreground">{t("aiopc.inbox.loading")}</p> : null}
          <TabsContent value="pending" className="mt-3 space-y-2">
            {pending.map(review => (
              <PendingRow key={review.id} title={review.payload.title || t("aiopc.publish_review.title")} detail={[review.project && folderName(review.project), review.platform, review.account].filter(Boolean).join(" · ")} icon={<Send />}>
                <SavedPublishReviewCard
                  review={review}
                  origin={host && workspaceId && review.sessionId && client ? { client: host, workspaceId, sessionId: review.sessionId, engine: native ? "v2" : "v1", readOnly: false } : null}
                  workspaceRoot={workspaceRoot}
                />
                {review.sessionId ? <OpenSession open={() => props.openSession(review.sessionId!)} /> : null}
              </PendingRow>
            ))}
            {(permissions.data ?? []).map(permission => (
              <PendingRow key={`permission:${permission.id}`} title={t("aiopc.inbox.permission")} detail={permission.permission} icon={<ShieldCheck />}>
                <PermissionApprovalPanel permission={permission} busy={busy !== null} respondPermission={client ? (requestID, reply) => {
                  void act(permission.id, async () => {
                    if (isOpencodeV2Client(client)) unwrap(await client.v2.session.permission.reply({ sessionID: permission.sessionID, requestID, reply }));
                    else unwrap(await client.permission.reply({ directory, requestID, reply }));
                    settlePermissionState(workspaceId, permission.sessionID, permission.id);
                  }, permissions.refetch);
                } : undefined} />
                <OpenSession open={() => props.openSession(permission.sessionID)} />
              </PendingRow>
            ))}
            {(questions.data ?? []).map(question => {
              const canReply = client && !isReservedConnectionQuestion({ questions: question.questions });
              const answer = (answers: string[][] | null) => {
                if (!canReply) return;
                void act(question.id, async () => {
                  const ids = { requestID: question.id, sessionID: question.sessionID };
                  const result = isOpencodeV2Client(client)
                    ? answers === null ? await client.rejectSessionQuestion(ids) : await client.replySessionQuestion({ ...ids, answers })
                    : answers === null ? await client.question.reject({ requestID: question.id, directory }) : await client.question.reply({ requestID: question.id, directory, answers });
                  unwrap(result);
                  settleQuestionState(workspaceId, question.sessionID, question.id);
                }, questions.refetch);
              };
              return (
                <PendingRow key={`question:${question.id}`} title={question.questions[0]?.header || t("aiopc.inbox.question")} detail={question.questions[0]?.question || t("aiopc.inbox.question")} icon={<MessageCircleQuestion />}>
                  {canReply ? <QuestionPanel questions={question.questions} busy={busy !== null} onReply={answer} onDismiss={() => answer(null)} /> : null}
                  <OpenSession open={() => props.openSession(question.sessionID)} />
                </PendingRow>
              );
            })}
            {pendingReady && !pendingCount ? <InboxEmpty label={t("aiopc.inbox.empty_pending")} /> : null}
          </TabsContent>
          <TabsContent value="results" className="mt-3 space-y-2">
            {receipts.data?.length ? <InboxResults items={receipts.data} /> : null}
            {handled.map(review => (
              <PendingRow key={review.id} title={review.payload.title || t("aiopc.publish_review.title")} detail={t(`aiopc.publish_review.${review.status}`)} icon={<Send />}>
                <SavedPublishReviewCard review={review} origin={null} workspaceRoot={workspaceRoot} />
                {review.sessionId ? <OpenSession open={() => props.openSession(review.sessionId!)} /> : null}
              </PendingRow>
            ))}
            {resultsReady && !receipts.data?.length && !handled.length ? <InboxEmpty label={t("aiopc.inbox.empty_results")} /> : null}
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

function InboxEmpty({ label }: { label: string }) {
  return <div className="flex items-center gap-3 rounded-xl border border-border px-4 py-5 text-sm text-muted-foreground"><Inbox className="size-4" aria-hidden />{label}</div>;
}
