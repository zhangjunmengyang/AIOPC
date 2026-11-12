import type { ModelOption, ModelRef } from "@/app/types";
import { getModelBehaviorSummary } from "@/app/lib/model-behavior";
import { getConnectedProviderItems } from "@/react-app/infra/provider-list-query";
import { markDisabledModelOptions, mergeModelOptions } from "../connections/provider-auth/assigned-model-options";
import { hideBuiltInZenFallback } from "../connections/provider-auth/provider-policy";
import { modelRefKey } from "../session/models/model-collections-store";
import type { ModelCatalogOption, ModelPickerCatalogState, RetainedModelSelection } from "./model-catalog";

type ProviderList = Parameters<typeof getConnectedProviderItems>[0];

/** A model the engine reports at no cost. Only the built-in Zen fallback rule reads this. */
function costsNothing(model: { cost?: { input?: number; output?: number } }) {
  return model.cost?.input === 0 && model.cost?.output === 0;
}

/** The one place a connected provider's models become picker options. */
export function runtimeModelOptions(data: ProviderList, isNewProvider: (providerId: string) => boolean = () => false): ModelOption[] {
  return getConnectedProviderItems(data).flatMap((provider) => Object.entries(provider.models).map(([id, model]): ModelOption => {
    const summary = getModelBehaviorSummary(provider.id, model, null, provider.name);
    const ref = { providerID: provider.id, modelID: id };
    return {
      ...ref, title: model.name || id, description: provider.name,
      behaviorTitle: summary.title, behaviorLabel: summary.label, behaviorDescription: summary.description,
      behaviorValue: summary.value, behaviorOptions: summary.options,
      isFree: costsNothing(model),
      // Zen with the person's own key or subscription (OpenWork, `opencode auth login`, env or config) is a real
      // provider and stays listed in full; only the credential-less built-in Zen is a fallback.
      ...(provider.id === "opencode" && provider.source === "custom" && costsNothing(model) ? { zenFallback: true } : {}),
      ...(isNewProvider(provider.id) ? { isRecommended: true } : {}),
    };
  }));
}


export type ModelCatalogInput = {
  runtime: readonly ModelOption[] | null;
  fallback?: readonly ModelOption[];
  disabledProviders?: readonly string[];
};
export type ModelCatalog = { known: ModelCatalogOption[]; options: ModelCatalogOption[] };

export function buildModelCatalog(input: ModelCatalogInput): ModelCatalog {
  const merged = mergeModelOptions(input.runtime ?? [], input.fallback ?? []);
  const known = markDisabledModelOptions(merged, input.disabledProviders ?? []);
  return { known, options: hideBuiltInZenFallback(known.filter(option => !option.disabled)) };
}

export type RetainedSelectionInput = {
  current: ModelRef;
  catalog: ModelCatalog;
  remembered?: ModelOption;
  saved?: RetainedModelSelection;
  catalogState: ModelPickerCatalogState["state"];
  sessionScoped: boolean;
};
export function resolveRetainedSelection(input: RetainedSelectionInput): RetainedModelSelection | undefined {
  const { current } = input;
  if (!current.providerID || !current.modelID) return undefined;
  const key = modelRefKey(current);
  const saved = input.saved && modelRefKey(input.saved.model) === key ? input.saved : undefined;
  if (saved?.reason !== "disabled" && input.catalog.options.some(option => modelRefKey(option) === key && !option.disabled)) return undefined;
  const known = input.catalog.known.find(option => modelRefKey(option) === key)
    ?? (input.remembered && modelRefKey(input.remembered) === key ? input.remembered : undefined);
  const implicitStarter = !input.sessionScoped && !known && !saved && current.providerID === "opencode" && current.modelID === "big-pickle";
  if (implicitStarter || (known?.zenFallback && !known.disabled && saved?.reason !== "disabled") || input.catalogState === "loading") return undefined;
  return { model: current, title: known?.title ?? saved?.title, description: known?.description ?? saved?.description,
    reason: saved?.reason ?? (known?.disabled ? "disabled" : "unavailable") };
}
export function withoutBlockedSelection(options: readonly ModelCatalogOption[], retained: RetainedModelSelection | undefined): ModelCatalogOption[] {
  return retained?.reason === "disabled" ? options.filter(option => modelRefKey(option) !== modelRefKey(retained.model)) : [...options];
}
