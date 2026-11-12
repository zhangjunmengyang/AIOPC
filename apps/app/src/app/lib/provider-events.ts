/**
 * Global DOM event fired when new providers become available in the
 * workspace after local configuration changes or manual setup.
 *
 * Listeners (e.g. the global NewProvidersListener) should use this to
 * surface a notification-center entry.
 */
export const newProvidersEvent = "openwork-new-providers-available";

export type ProviderCatalogScope = {
  baseUrl: string;
  directory?: string;
  reason?: "native" | "reconnect";
};
const catalogListeners = new Set<(scope: ProviderCatalogScope) => void>();

export function subscribeProviderCatalogChanges(listener: (scope: ProviderCatalogScope) => void) {
  catalogListeners.add(listener);
  return () => { catalogListeners.delete(listener); };
}

export function dispatchProviderCatalogChanged(scope: ProviderCatalogScope) {
  for (const listener of catalogListeners) listener(scope);
}

export type NewProviderInfo = {
  id: string;
  name: string;
  providerId: string;
  firstModelId?: string;
  firstModelName?: string;
};

export type NewProvidersEventDetail = {
  providers: NewProviderInfo[];
  newProviderCount?: number;
  newModelCount?: number;
  source: "local_config" | "models_refresh";
};

export function dispatchNewProviders(detail: NewProvidersEventDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<NewProvidersEventDetail>(newProvidersEvent, { detail }),
  );
}
