/** @jsxImportSource react */
import { MultiFileDiff } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import type { DynamicToolUIPart } from "ai";
import { FileText, Send } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";

import { createMcpAppActions, type McpAppOrigin } from "@/components/chat/mcp-app-origin";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

import { useAiopc } from "./aiopc-client";

const toolName = "aiopc_social_publish";
const resourceUri = "ui://aiopc/publish-review";
const statusSchema = z.enum(["awaiting_approval", "filling", "composer_filled", "rejected", "failed", "expired"]);
const mediaSchema = z.array(z.object({ name: z.string(), preview: z.string().optional() }));
const payloadSchema = z.object({
  title: z.string(), text: z.string(), form: z.string(), account_id: z.string(), media: z.array(z.string()), tags: z.array(z.string()),
});
export const publishReviewSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/), digest: z.string().regex(/^[a-f0-9]{64}$/), created_at: z.number(),
  sessionId: z.string().optional(), project: z.string().optional(),
  status: statusSchema, platform: z.string(), account: z.string(), payload: payloadSchema,
  previousPayload: payloadSchema.optional(),
  previewMedia: mediaSchema.optional(),
});
export type PublishReview = z.infer<typeof publishReviewSchema>;
type Decision = "approve" | "reject";
type MediaPreview = { name: string; preview?: string };

const mcpResultSchema = z.object({
  isError: z.boolean().optional(), structuredContent: publishReviewSchema,
  _meta: z.object({ media: mediaSchema.optional() }).optional(),
});

export function readPublishReviewPart(part: DynamicToolUIPart) {
  if ((part.toolName !== toolName && part.toolName !== "aiopc.social_publish") || part.state !== "output-available") return null;
  const metadata = part.callProviderMetadata?.openwork;
  const parsed = mcpResultSchema.safeParse(metadata?.mcpResult ?? metadata?.mcpApp);
  if (!parsed.success || parsed.data.isError) return null;
  return { review: parsed.data.structuredContent, media: parsed.data._meta?.media };
}

export async function submitPublishReview(origin: McpAppOrigin, review: PublishReview, decision: Decision) {
  if (origin.readOnly || !origin.sessionId || (review.sessionId && review.sessionId !== origin.sessionId)
    || review.status !== "awaiting_approval") {
    throw new Error(t("aiopc.publish_review.session_required"));
  }
  const { client, workspaceId, sessionId, engine } = origin;
  const { app } = await client.resolveMcpApp(workspaceId, toolName, undefined, { sessionId, readOnly: false, engine });
  try {
    if (app?.serverName !== "aiopc" || app.toolName !== "social_publish" || app.resourceUri !== resourceUri || !app.launchId) {
      throw new Error(t("aiopc.publish_review.unavailable"));
    }
    const actions = createMcpAppActions(origin, app);
    try {
      const result = await actions.callTool("social_confirm_publish", {
        review_id: review.id, revision: review.digest, decision, ...(review.project ? { project: review.project } : {}),
      }, true);
      if (result.isError) {
        const message = result.content.flatMap(item => typeof item.text === "string" ? [item.text] : []).join("\n");
        throw new Error(message || t("app.error_request_failed"));
      }
      const status = result.structuredContent?.status;
      if (status === "composer_filled" || status === "rejected") return status;
      throw new Error(t("aiopc.publish_review.result_unknown"));
    } finally {
      actions.dispose();
    }
  } finally {
    if (app?.launchId) void client.releaseMcpApp(workspaceId, app.launchId).catch(() => undefined);
  }
}

function draftText(payload: PublishReview["payload"]) {
  return [payload.title, "", payload.text, "", payload.tags.map(tag => `#${tag}`).join(" "), ...payload.media].join("\n");
}

export function PublishReviewCard({ review, media, origin, onChanged }: {
  review: PublishReview;
  media?: MediaPreview[];
  origin: McpAppOrigin | null;
  onChanged?: (status?: PublishReview["status"]) => void;
}) {
  const [busy, setBusy] = useState<Decision | null>(null);
  const [terminalStatus, setTerminalStatus] = useState<PublishReview["status"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const inFlight = useRef(false);
  const status = review.status === "awaiting_approval" ? terminalStatus ?? review.status : review.status;
  const canDecide = status === "awaiting_approval" && origin?.sessionId && !origin.readOnly
    && (!review.sessionId || review.sessionId === origin.sessionId);

  async function decide(decision: Decision) {
    if (!canDecide || !origin || inFlight.current) return;
    inFlight.current = true;
    setBusy(decision);
    setError(null);
    try {
      const resolved = await submitPublishReview(origin, review, decision);
      setTerminalStatus(resolved);
      onChanged?.(resolved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("app.error_request_failed"));
      onChanged?.();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground" aria-label={t("aiopc.publish_review.title")}>
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <Send className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{t("aiopc.publish_review.title")}</h3>
          <p className="break-words text-xs text-muted-foreground">{review.platform} · {review.account}</p>
        </div>
        <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground" role="status">
          {t(`aiopc.publish_review.${status}`)}
        </span>
      </header>
      <div className="space-y-3 px-4 py-3">
        {review.previousPayload ? (
          <Button type="button" variant="outline" size="sm" aria-expanded={showDiff} onClick={() => setShowDiff(value => !value)}>
            {t(showDiff ? "aiopc.publish_review.show_draft" : "aiopc.publish_review.compare")}
          </Button>
        ) : null}
        {showDiff && review.previousPayload ? (
          <div className="max-h-80 overflow-auto rounded-md border border-border">
            <MultiFileDiff
              oldFile={{ name: "draft.txt", contents: draftText(review.previousPayload) }}
              newFile={{ name: "draft.txt", contents: draftText(review.payload) }}
              options={{ diffStyle: "unified", disableFileHeader: true, overflow: "wrap" }}
            />
          </div>
        ) : (
          <div className="space-y-2">
            {review.payload.title ? <p className="break-words text-sm font-semibold">{review.payload.title}</p> : null}
            <p className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-sm">{review.payload.text}</p>
            {review.payload.tags.length ? <p className="break-words text-xs text-muted-foreground">{review.payload.tags.map(tag => `#${tag}`).join(" ")}</p> : null}
          </div>
        )}
        {review.payload.media.length ? (
          <ul className="flex flex-wrap gap-2" aria-label={t("aiopc.publish_review.attachments")}>
            {review.payload.media.map((path, index) => {
              const name = path.split(/[/\\]/).at(-1) || path;
              const preview = media?.[index]?.name === name ? media[index].preview : undefined;
              return (
                <li className="flex min-w-0 max-w-48 flex-col gap-1 rounded-md border border-border px-2 py-1.5 text-xs" key={`${index}:${path}`}>
                  {preview && /^data:image\/(?:jpeg|png|webp);base64,[a-zA-Z0-9+/=]+$/.test(preview) ? (
                    <img alt={name} className="max-h-24 rounded-sm object-contain" src={preview} />
                  ) : <FileText className="size-4 text-muted-foreground" aria-hidden />}
                  <span className="truncate" title={name}>{name}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {error ? <p role="alert" className="break-words text-xs text-destructive">{error}</p> : null}
      </div>
      {canDecide ? (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
          <p className="text-xs text-muted-foreground">{t("aiopc.publish_review.fill_hint")}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void decide("reject")}>
              {t("aiopc.publish_review.reject")}
            </Button>
            <Button type="button" size="sm" disabled={Boolean(busy)} onClick={() => void decide("approve")}>
              {t(busy === "approve" ? "aiopc.publish_review.filling" : "aiopc.publish_review.approve")}
            </Button>
          </div>
        </footer>
      ) : null}
    </section>
  );
}

export function SavedPublishReviewCard({ review, media, origin, workspaceRoot }: {
  review: PublishReview; media?: MediaPreview[]; origin: McpAppOrigin | null; workspaceRoot: string;
}) {
  const { ready, request, invalidate } = useAiopc(workspaceRoot);
  const saved = useQuery({
    queryKey: ["aiopc", workspaceRoot, "publish-reviews", review.id],
    queryFn: async () => publishReviewSchema.parse(await request("GET", `/api/publish-reviews/${review.id}`, { params: { project: review.project } })),
    enabled: ready,
    staleTime: 5_000,
    retry: false,
  });
  const frozen = saved.data?.digest === review.digest && (!origin || !saved.data.sessionId || saved.data.sessionId === origin.sessionId) ? saved.data : null;
  return (
    <>
      <PublishReviewCard key={review.id} review={frozen ?? review} media={frozen?.previewMedia ?? media} origin={frozen ? origin : null} onChanged={() => { void invalidate("publish-reviews"); }} />
      {saved.isError && review.status === "awaiting_approval" ? (
        <p role="status" className="px-1 py-1 text-xs text-muted-foreground">{t("aiopc.publish_review.status_unavailable")}</p>
      ) : null}
    </>
  );
}
