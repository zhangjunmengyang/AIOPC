import { AUTO_ROUTER_PROVIDER_ID, autoRouterIdFromModel } from "@openwork/types/auto-router";
import { FAST_DEFAULT_VARIANT } from "@openwork/types/model-fast";
import { getModelBehaviorControls, getModelBehaviorSelection } from "@/app/lib/model-behavior";
import type { ModelOption, ModelRef } from "@/app/types";
import { modelRefKey, nextFavoriteModel } from "../session/models/model-collections-store";

export type ModelPickerCatalogState = {
  state: "loading" | "ready" | "error";
  lastVerifiedAt?: number;
  refreshing?: boolean;
  onRetry?: () => void | Promise<unknown>;
};
export type RetainedModelSelection = {
  model: ModelRef;
  title?: string;
  description?: string;
  reason: "unavailable" | "policy" | "disabled" | "signed-out";
};
export function retainedModelCopy(reason: RetainedModelSelection["reason"]) {
  switch (reason) {
    case "policy": return { subtitle: "blocked by your organization", detail: "Your organization decides which providers are allowed here." };
    case "disabled": return { subtitle: "disabled in AI providers", detail: "Turn this provider back on in AI providers, or choose another model." };
    case "signed-out": return { subtitle: "sign in to verify access", detail: "Sign in to verify access to your saved model, or choose a connected provider." };
    case "unavailable": return { subtitle: "no longer available here", detail: "Your saved model isn’t available here anymore." };
  }
}
export function nonDefaultModelSummary(model: ModelRef, value: string | null, label: string) {
  return !managesOwnBehavior(model) && value !== null ? label : null;
}

/**
 * What a picker's trigger says after the model's name: its non-default setting, and whether Fast is on
 * (shown on its own, so the setting beside it is the base level: "High", not "High + Fast").
 * A saved setting the model does not list is only called out once the list is verified. While the list is
 * still loading, or the model has no name here, the trigger says nothing rather than a raw setting id.
 */
export function modelTriggerSettings(input: {
  model: ModelRef;
  /** The trigger shows this model's name, not "Select model". */
  named: boolean;
  /** The model list is the engine's own answer for a verified sign-in, not a saved or partial one. */
  verified: boolean;
  options: readonly { value: string | null; label: string; description?: string }[];
  value: string | null;
}): { summary: string | null; fast: boolean } {
  if (!input.named || managesOwnBehavior(input.model)) return { summary: null, fast: false };
  const selection = getModelBehaviorSelection(input.options, input.value);
  const controls = getModelBehaviorControls(selection.options, selection.value);
  if (controls.fast) {
    return { fast: true, summary: input.value === FAST_DEFAULT_VARIANT ? null : controls.options.find((option) => option.value === input.value)?.label ?? null };
  }
  const listed = selection.options.some((option) => option.value === input.value);
  return { fast: false, summary: listed || input.verified ? nonDefaultModelSummary(input.model, input.value, selection.label) : null };
}
/** `plainFreeModel`: the free model is named, marked and described like every other model. */
export type ModelDisplayOptions = { plainFreeModel?: boolean };
/** The picker group that holds only Smart Router models, above everything else, without a label. */
export const AUTO_ROUTER_GROUP = "Smart";
/** What a Smart Router model is called when the engine reports no name for it. */
export const SMART_MODEL_FALLBACK_NAME = "Smart";

/**
 * One of the organization's Smart Routers (feature `autoRouter`): the Gateway
 * picks the real model for every prompt. Every router is a model of the one
 * `openwork-auto` provider, named "Smart: <router name>". Not OpenWork Free.
 */
export function isAutoRouterModel(model: ModelRef | null | undefined) {
  return model?.providerID === AUTO_ROUTER_PROVIDER_ID;
}

/** Models that choose their own settings, so they offer no effort, fast mode or inherited behavior. */
export function managesOwnBehavior(model: ModelRef | null | undefined) {
  return isAutoRouterModel(model);
}
export const EXPLICIT_MODEL_CHOICE_KEY = "openwork.modelChoice.explicit";
export function markExplicitModelChoice() {
  try { window.localStorage.setItem(EXPLICIT_MODEL_CHOICE_KEY, "1"); } catch {}
}

/**
 * The display name of OpenWork Free whatever the engine calls it, or a Smart
 * Router's own name ("Smart: Engineering") when it is known; undefined
 * otherwise.
 */
export function fixedModelTitle(model: ModelRef & { title?: string }, display: ModelDisplayOptions = {}): string | undefined {
  if (isAutoRouterModel(model)) {
    const title = model.title?.trim();
    return title && title !== model.modelID && autoRouterIdFromModel(title) === null ? title : undefined;
  }
  return undefined;
}

/** Gateway ids (`gwm_…`, `ipr_…`) are long and opaque: never a name a person reads. */
function isOpaqueModelId(value: string) {
  return /^(gwm|ipr)_/.test(value);
}

/** A model's display name: its title, never an opaque gateway id (then "<Provider> model"). */
export function modelTitle(model: ModelRef & { title?: string; description?: string }, display: ModelDisplayOptions = {}) {
  const fixed = fixedModelTitle(model, display);
  if (fixed) return fixed;
  // A Smart model's id (`openwork-smart-…`) is never a name a person reads.
  if (isAutoRouterModel(model)) return SMART_MODEL_FALLBACK_NAME;
  const name = model.title?.trim() || model.modelID;
  if (!isOpaqueModelId(name)) return name;
  const provider = model.description?.trim();
  return provider ? `${provider} model` : "Model";
}

/** A name safe to show as a value: the public title, never an opaque provider/model id. */
export function publicModelTitle(model: ModelRef & { title?: string }): string | undefined {
  const fixed = fixedModelTitle(model);
  if (fixed) return fixed;
  if (isAutoRouterModel(model)) return SMART_MODEL_FALLBACK_NAME;
  const title = model.title?.trim();
  if (!title || title === model.modelID || isOpaqueModelId(title)) return undefined;
  return title;
}

const MODEL_MAKERS: readonly [RegExp, string][] = [
  [/\bclaude\b/, "anthropic"], [/\b(gpt|codex|o[1-9])(\b|-|\d)/, "openai"], [/\b(gemini|gemma)\b/, "google"],
  [/\bgrok\b/, "xai"], [/\bllama\b/, "meta"], [/\b(mistral|codestral|devstral|magistral)\b/, "mistral"], [/\bdeepseek\b/, "deepseek"],
];

/**
 * Who made a model, from its name: Claude is Anthropic's wherever it is served.
 * The picker shows this maker's logo, so a gateway or self-hosted provider
 * without a logo of its own still reads at a glance. Null when unknown.
 */
export function modelMakerId(model: ModelRef & { title?: string }): string | null {
  const text = `${model.title ?? ""} ${model.modelID}`.toLowerCase();
  return MODEL_MAKERS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/** Only what is true about this model right now, without its provider (rows already show the logo and group). */
export function modelStateLabel(model: ModelOption): string | null {
  return null;
}

export function modelSubtitle(model: ModelOption, exhausted = false, display: ModelDisplayOptions = {}) {
  if (isAutoRouterModel(model)) return "Picks the best model for each task";
  return model.description?.trim() ?? "";
}

export type ModelCatalogOption = ModelOption & { defaultPinned?: boolean };

export function orderedModelPins(options: readonly ModelCatalogOption[], personal: readonly ModelRef[]) {
  const available = options.filter((option) => !option.disabled);
  const byKey = new Map(available.map((option) => [modelRefKey(option), option]));
  const ordered = [
    ...personal.flatMap((model) => { const option = byKey.get(modelRefKey(model)); return option ? [option] : []; }),
  ];
  return [...new Map(ordered.map((option) => [modelRefKey(option), option])).values()];
}

export function nextPinnedModel(options: readonly ModelOption[], personal: readonly ModelRef[], current: ModelRef | null) {
  return nextFavoriteModel(orderedModelPins(options, personal), current);
}

export type ModelGroup = { value: string; items: ModelOption[] };
export function modelGroups(options: readonly ModelOption[], personal: readonly ModelRef[], recent: readonly ModelRef[], query = ""): ModelGroup[] {
  const groups: ModelGroup[] = [];
  const shown = new Set<string>();
  const search = query.trim().toLowerCase();
  const available = options.filter((option) => !option.disabled);
  // `claim`: listed only here. Recent is a shortcut; its models still appear under their provider.
  const add = (value: string, candidates: readonly ModelOption[], claim = true) => {
    const items = candidates.filter((option) => {
      const key = modelRefKey(option);
      if (shown.has(key) || (search && !`${modelTitle(option)} ${modelSubtitle(option)} ${key}`.toLowerCase().includes(search))) return false;
      if (claim) shown.add(key);
      return true;
    });
    if (items.length) groups.push({ value, items });
  };
  // Smart Routers stand alone at the top, by name, wherever else they would be listed.
  add(AUTO_ROUTER_GROUP, available.filter(isAutoRouterModel)
    .sort((a, b) => modelTitle(a).localeCompare(modelTitle(b)) || a.modelID.localeCompare(b.modelID)));
  add("Pinned", orderedModelPins(available, personal));
  add("Recent", recent.flatMap((model) => available.filter((option) => modelRefKey(option) === modelRefKey(model))), false);
  const providers = [...new Set(available.map((option) => option.providerID))].sort((a, b) => {
    const name = (id: string) => available.find((option) => option.providerID === id)?.description || id;
    return name(a).localeCompare(name(b));
  });
  for (const id of providers) {
    const models = available.filter((option) => option.providerID === id).sort((a, b) => modelTitle(a).localeCompare(modelTitle(b)));
    add(models[0]?.description || id, models);
  }
  return groups;
}

/**
 * The model to fall back to when `unavailable` stops working: the first other
 * model in the order the picker lists them (pinned, recent, then by provider)
 * that `usable` accepts. Null when nothing else can run.
 */
export function nextAvailableModel(
  options: readonly ModelOption[],
  personal: readonly ModelRef[],
  recent: readonly ModelRef[],
  unavailable: ModelRef,
  usable: (model: ModelOption) => boolean = () => true,
): ModelOption | null {
  const skip = modelRefKey(unavailable);
  return modelGroups(options, personal, recent).flatMap((group) => group.items)
    .find((option) => modelRefKey(option) !== skip && usable(option)) ?? null;
}

export function isPinModelShortcut(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
  return event.key.toLowerCase() === "p" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function isCycleModelSourceShortcut(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
  return event.key.toLowerCase() === "m" && event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey;
}
