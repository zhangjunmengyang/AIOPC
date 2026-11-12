import { useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSetWorkspaceDefaultModel } from "@/react-app/kernel/use-workspace-model-default";
import { ModelPickerPanel } from "@/react-app/domains/models/model-picker-panel";
import { buildModelCatalog, resolveRetainedSelection, withoutBlockedSelection } from "@/react-app/domains/models/catalog";
import { useModelChoice } from "@/react-app/domains/models/use-model-catalog";
import type { ModelOption, ModelRef } from "@/app/types";
import { managesOwnBehavior, type ModelCatalogOption, type ModelPickerCatalogState, type RetainedModelSelection } from "@/react-app/domains/models/model-catalog";

export const MODEL_PICKER_DEFAULT_SUBTITLE = "Select a model for this session.";
export const MODEL_PICKER_UNAVAILABLE_SUBTITLE = "The model you were using is no longer available, please select a different model for this session.";
export function resolveModelPickerSubtitle(subtitle: string | undefined) { return subtitle ?? MODEL_PICKER_DEFAULT_SUBTITLE; }

export type ModelPickerModalProps = {
  open: boolean;
  /** What to list: the shared catalog's options for this surface. */
  options: readonly ModelCatalogOption[];
  /** Everything the person could have chosen, disabled rows included; names a saved choice that is not listed. */
  knownOptions?: readonly ModelCatalogOption[];
  disabledProviders?: string[];
  query: string;
  setQuery: (value: string) => void;
  subtitle?: string;
  target: "default" | "session";
  current: ModelRef;
  currentBehaviorValue?: string | null;
  onSelect: (model: ModelRef) => void;
  onBehaviorChange: (model: ModelRef, value: string | null) => void;
  onToggleProvider?: (providerId: string, enabled: boolean) => void;
  onOpenSettings: () => void;
  onClose: (options?: { restorePromptFocus?: boolean }) => void;
  catalogState?: ModelPickerCatalogState;
  retainedSelection?: RetainedModelSelection;
  onSetWorkspaceDefault?: (model: ModelRef, variant?: string | null) => void | boolean | Promise<void | boolean>;
  onOpenProviderSettings?: () => void;
  onReloadWorkspace?: () => void | Promise<unknown>;
};

export function ModelPickerModal(props: ModelPickerModalProps) {
  const isMobile = useIsMobile();
  const setWorkspaceDefault = useSetWorkspaceDefaultModel();
  const popupRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const choice = useModelChoice(JSON.stringify([props.open, props.current, props.currentBehaviorValue]));
  const catalogState = props.catalogState ?? { state: "ready" } satisfies ModelPickerCatalogState;
  // Callers pass the shared catalog; applying the same pipeline here keeps the dialog correct for any caller
  // (it is idempotent) and applies this dialog's own policy, disabled-provider and gateway inputs.
  const catalog = buildModelCatalog({ runtime: [...(props.knownOptions ?? props.options)], disabledProviders: props.disabledProviders });
  const retained = resolveRetainedSelection({ current: props.current, catalog, saved: props.retainedSelection, catalogState: catalogState.state, sessionScoped: props.target === "session" });
  const options = withoutBlockedSelection(catalog.options, retained);
  const selected = options.find((option) => option.providerID === props.current.providerID && option.modelID === props.current.modelID && !option.disabled);
  const behaviorValue = props.currentBehaviorValue !== undefined ? props.currentBehaviorValue : selected?.behaviorValue ?? null;
  useEffect(() => { if (props.open) props.setQuery(""); }, [props.open]);
  const openSettings = () => { props.onClose({ restorePromptFocus: false }); (props.onOpenProviderSettings ?? props.onOpenSettings)(); };
  // The same panel as the composer's picker, in a dialog for surfaces without a composer.
  return <Dialog open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <DialogContent ref={popupRef} showCloseButton={false} initialFocus={() => isMobile ? popupRef.current : searchInputRef.current} aria-describedby={undefined}
      className="flex max-h-[min(calc(100dvh-2rem),36rem)] min-h-0 w-90 max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-90 lg:w-90 lg:max-w-90 lg:rounded-2xl" data-testid="all-models-picker">
      <DialogTitle className="sr-only">Models</DialogTitle>
      <ModelPickerPanel searchInputRef={searchInputRef} options={options} current={props.current} behaviorValue={behaviorValue}
        onSelect={(option, behavior) => choice.choose(option, () => {
          props.onSelect({ providerID: option.providerID, modelID: option.modelID });
          if (behavior && !managesOwnBehavior(option)) props.onBehaviorChange({ providerID: option.providerID, modelID: option.modelID }, behavior.variant);
        })}
        onBehaviorChange={(value) => props.onBehaviorChange(props.current, value)}
        catalogState={catalogState} retainedSelection={retained}
        onConnectProvider={props.onOpenSettings}
        onOpenProviderSettings={openSettings}
        onSetWorkspaceDefault={props.onSetWorkspaceDefault ?? setWorkspaceDefault}
        onReloadWorkspace={props.onReloadWorkspace}
        />
    </DialogContent>
  </Dialog>;
}
