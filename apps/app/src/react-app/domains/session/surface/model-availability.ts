// Availability of one provider/model identity against the active workspace's
// provider catalogs. The route builds a resolver from its catalog state and
// each composer (an existing conversation or the New Task default) evaluates
// its OWN effective model through it, so a missing global default can never
// disable a conversation that remembers a different, valid model — and vice
// versa. `pending` is explicit: an unsettled catalog (still loading, cloud
// provider sync incomplete, or superseded by a workspace switch) never
// produces a definitive "unavailable" verdict.
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { ModelRef } from "@/app/types";
import { isModelAvailableInConnectedProviders } from "@/react-app/infra/provider-list-query";

export type ModelUnavailableReason =
  | "provider_blocked"
  | "provider_not_connected"
  | "model_missing";

export type ModelAvailability =
  | { status: "pending" }
  | { status: "available" }
  | { status: "unavailable"; reason: ModelUnavailableReason };

export type ModelAvailabilityResolver = (model: ModelRef | null) => ModelAvailability;

export type ModelAvailabilityContext = {
  workspaceReady: boolean;
  loading: boolean;
  providerList: ProviderListResponse | null | undefined;
};

export function computeModelAvailability(model: ModelRef | null | undefined, context: ModelAvailabilityContext): ModelAvailability {
  if (!context.workspaceReady || context.loading || !context.providerList || !model?.providerID?.trim() || !model.modelID?.trim()) return { status: "pending" };
  if (!isModelAvailableInConnectedProviders(context.providerList, model)) return { status: "unavailable", reason: "model_missing" };
  return { status: "available" };
}

/**
 * How long a catalog-derived "unavailable" verdict must persist before it is
 * shown. Settings visits and engine reload/restart churn can settle a
 * momentarily incomplete catalog (e.g. `connected` not yet populated), which
 * used to flash "Model no longer available" for a beat before the next
 * refresh restored the model.
 */
export const MODEL_UNAVAILABLE_CONFIRMATION_MS = 1_200;

export type UnavailableConfirmationGate = {
  /**
   * Confirm one verdict for one model identity. Catalog denials
   * (`model_missing`, `provider_not_connected`) surface only after they have
   * persisted for the confirmation window; younger denials render as pending
   * so a transition blip never flashes the warning or blocks a send. Policy
   * blocks (`provider_blocked`) are deliberate local state and pass through
   * immediately, as do `available` and `pending`.
   */
  confirm: (
    model: ModelRef | null | undefined,
    verdict: ModelAvailability,
  ) => ModelAvailability;
  /**
   * Milliseconds until the next immature denial matures, or null when every
   * tracked denial has matured (or none are tracked). Mature denials must not
   * schedule a busy loop or hide another model's pending deadline.
   */
  nextRecheckDelay: (nowMs?: number) => number | null;
};

export function createUnavailableConfirmationGate(options?: {
  confirmMs?: number;
  now?: () => number;
}): UnavailableConfirmationGate {
  const confirmMs = options?.confirmMs ?? MODEL_UNAVAILABLE_CONFIRMATION_MS;
  const now = options?.now ?? Date.now;
  const firstDeniedAtByModel = new Map<string, number>();
  const keyOf = (model: ModelRef | null | undefined) =>
    `${model?.providerID?.trim() ?? ""}:${model?.modelID?.trim() ?? ""}`;

  return {
    confirm(model, verdict) {
      const key = keyOf(model);
      if (verdict.status !== "unavailable" || verdict.reason === "provider_blocked") {
        firstDeniedAtByModel.delete(key);
        return verdict;
      }
      const current = now();
      const deniedAt = firstDeniedAtByModel.get(key);
      if (deniedAt === undefined) {
        firstDeniedAtByModel.set(key, current);
        return { status: "pending" };
      }
      if (current - deniedAt < confirmMs) return { status: "pending" };
      return verdict;
    },
    nextRecheckDelay(nowMs) {
      const current = nowMs ?? now();
      let next: number | null = null;
      for (const deniedAt of firstDeniedAtByModel.values()) {
        const remaining = confirmMs - (current - deniedAt);
        if (remaining <= 0) continue;
        next = next === null ? remaining : Math.min(next, remaining);
      }
      return next;
    },
  };
}
