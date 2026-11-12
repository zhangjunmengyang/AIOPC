import type { ModelOption } from "@/app/types";

const BUILT_IN_ZEN_PROVIDER_ID = "opencode";

/**
 * The engine's built-in OpenCode Zen models are a silent fallback, not a
 * provider people chose: they stay listed only while nothing else is
 * available. Zen set up with the person's own key or subscription (in
 * OpenWork or with `opencode auth login`) is a connected provider and always
 * stays listed in full. Matches the picker designs, which show Zen only under
 * Connect a provider.
 */
/**
 * The engine's built-in Zen with no key of the person's own. Settings and the
 * Connect a provider sheet list it under "Available to add" (Paper board 10);
 * Zen with a key, subscription, env or config entry is a connected provider.
 */
export function isKeylessZenProvider(provider: { id: string; source?: string }) {
  return provider.id.trim().toLowerCase() === BUILT_IN_ZEN_PROVIDER_ID && provider.source === "custom";
}

export function keylessProviderIds(providers: ReadonlyArray<{ id: string; source?: string }>): ReadonlySet<string> {
  return new Set(providers.filter(isKeylessZenProvider).map((provider) => provider.id));
}

export function hideBuiltInZenFallback<T extends Pick<ModelOption, "providerID"> & { zenFallback?: boolean }>(options: readonly T[]): T[] {
  const fallback = (option: T) => option.providerID === BUILT_IN_ZEN_PROVIDER_ID && option.zenFallback === true;
  return options.some((option) => !fallback(option)) ? options.filter((option) => !fallback(option)) : [...options];
}
