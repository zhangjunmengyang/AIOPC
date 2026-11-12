import type { ModelOption } from "@/app/types";

export function markDisabledModelOptions(options: readonly ModelOption[], disabledProviderIds: readonly string[]): ModelOption[] {
  const disabled = new Set(disabledProviderIds);
  return options.map((option) => disabled.has(option.providerID) ? { ...option, disabled: true } : option);
}

export function mergeModelOptions(
  primary: readonly ModelOption[],
  fallback: readonly ModelOption[],
): ModelOption[] {
  const merged = new Map<string, ModelOption>();
  for (const option of fallback) {
    merged.set(`${option.providerID}:${option.modelID}`, option);
  }
  for (const option of primary) {
    const key = `${option.providerID}:${option.modelID}`;
    const assigned = merged.get(key);
    merged.set(key, { ...assigned, ...option });
  }
  return [...merged.values()];
}
