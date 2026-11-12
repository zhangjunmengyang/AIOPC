import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Client, ModelOption, ModelRef } from "@/app/types";
import { newProvidersEvent } from "@/app/lib/provider-events";
import { useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { modelRefKey, useModelCollectionsStore } from "../session/models/model-collections-store";
import { buildModelCatalog, resolveRetainedSelection, runtimeModelOptions, withoutBlockedSelection } from "./catalog";
import type { ModelCatalogOption, ModelPickerCatalogState, RetainedModelSelection } from "./model-catalog";

export type UseModelCatalogInput = {
  client: Client | null;
  baseUrl: string;
  directory?: string;
  enabled: boolean;
  refreshWhen?: boolean;
  fallbackOptions?: readonly ModelOption[];
  disabledProviders?: readonly string[];
  isNewProvider?: (providerId: string) => boolean;
  current?: ModelRef;
  savedSelection?: RetainedModelSelection;
  sessionScoped?: boolean;
};
export type ModelCatalogView = {
  options: ModelCatalogOption[];
  knownOptions: ModelCatalogOption[];
  actionOptions: ModelCatalogOption[];
  catalogState: ModelPickerCatalogState;
  retainedSelection?: RetainedModelSelection;
  currentOption?: ModelOption;
  error: unknown;
  refetch: () => Promise<unknown>;
};
export function providerListLoadState(input: { isError: boolean; isPending: boolean; isPlaceholderData: boolean; active: boolean }): ModelPickerCatalogState["state"] {
  if (input.isError) return "error";
  if (input.isPlaceholderData || (input.active && input.isPending)) return "loading";
  return "ready";
}

export function useModelCatalog(input: UseModelCatalogInput): ModelCatalogView {
  const providers = useProviderListQuery({ client: input.client, baseUrl: input.baseUrl, directory: input.directory || undefined,
    enabled: input.enabled && Boolean(input.client), showSavedWhileLoading: true });
  const refetch = providers.refetch;
  useEffect(() => { if (input.refreshWhen && input.client) void refetch(); }, [input.refreshWhen, input.client, refetch]);
  useEffect(() => {
    if (!input.client) return;
    const refresh = () => { void refetch(); };
    window.addEventListener(newProvidersEvent, refresh);
    return () => window.removeEventListener(newProvidersEvent, refresh);
  }, [input.client, refetch]);
  const runtime = useMemo(() => providers.data?.all ? runtimeModelOptions(providers.data, input.isNewProvider) : null, [providers.data, input.isNewProvider]);
  const catalog = useMemo(() => buildModelCatalog({ runtime, fallback: input.fallbackOptions, disabledProviders: input.disabledProviders }),
    [runtime, input.fallbackOptions, input.disabledProviders]);
  const catalogState: ModelPickerCatalogState = {
    state: providerListLoadState({ ...providers, active: Boolean(input.client) && input.enabled }),
    lastVerifiedAt: providers.dataUpdatedAt || undefined, refreshing: providers.isFetching, onRetry: input.client ? () => refetch() : undefined,
  };
  const identityScope = JSON.stringify([input.baseUrl, input.directory]);
  const remembered = useRef<{ scope: string; option: ModelOption } | null>(null);
  const current = input.current;
  const selectable = current ? catalog.options.find(option => modelRefKey(option) === modelRefKey(current) && !option.disabled) : undefined;
  useEffect(() => { if (selectable) remembered.current = { scope: identityScope, option: selectable }; }, [selectable, identityScope]);
  const rememberedOption = remembered.current?.scope === identityScope ? remembered.current.option : undefined;
  const retainedSelection = current ? resolveRetainedSelection({ current, catalog, remembered: rememberedOption, saved: input.savedSelection,
    sessionScoped: input.sessionScoped ?? false, catalogState: catalogState.state }) : undefined;
  const options = useMemo(() => withoutBlockedSelection(catalog.options, retainedSelection), [catalog.options, retainedSelection?.model.providerID, retainedSelection?.model.modelID, retainedSelection?.reason]);
  return { options, knownOptions: catalog.known, actionOptions: options, catalogState, retainedSelection,
    currentOption: selectable ?? (current ? catalog.known.find(option => modelRefKey(option) === modelRefKey(current))
      ?? (rememberedOption && modelRefKey(rememberedOption) === modelRefKey(current) ? rememberedOption : undefined) : undefined),
    error: providers.error, refetch };
}

export function useModelChoice(_contextKey: string) {
  const choose = useCallback((option: ModelOption, commit: () => void) => {
    if (option.disabled) return;
    useModelCollectionsStore.getState().recordRecent(option);
    commit();
  }, []);
  return { choose };
}
