import type { IReferencePatch } from "../../../types/referencePatches";
import type { LayerSelection } from "../../PolygonEditor";

export interface ILayerVisibilityStateInput {
  isEditingMode: boolean;
  layerSelection: LayerSelection;
  selectedPatchId: number | null | undefined;
  selectedBasePatch: IReferencePatch | null | undefined;
  patches: IReferencePatch[] | undefined;
}

export interface ILayerVisibilityState {
  showPredictionDeadwood: boolean;
  showPredictionForest: boolean;
  showReferenceDeadwood: boolean;
  showReferenceForest: boolean;
}

const HIDE_ALL_STATE: ILayerVisibilityState = {
  showPredictionDeadwood: false,
  showPredictionForest: false,
  showReferenceDeadwood: false,
  showReferenceForest: false,
};

export const getLayerVisibilityState = ({
  isEditingMode,
  layerSelection,
  selectedPatchId,
  selectedBasePatch,
  patches,
}: ILayerVisibilityStateInput): ILayerVisibilityState => {
  if (isEditingMode) return HIDE_ALL_STATE;

  const hasAnyReferenceData = (patches || []).some(
    (p) =>
      p.resolution_cm === 20 &&
      (p.reference_deadwood_label_id !== null || p.reference_forest_cover_label_id !== null),
  );

  const currentlySelectedPatch = patches?.find((p) => p.id === selectedPatchId);
  const isBasePatchSelected = !!currentlySelectedPatch && currentlySelectedPatch.resolution_cm === 20;
  const hasSubPatches =
    !!currentlySelectedPatch && currentlySelectedPatch.resolution_cm === 20
      ? !!patches?.some((p) => p.parent_tile_id === currentlySelectedPatch.id)
      : false;
  const hasReferenceData = !!(
    selectedBasePatch &&
    (selectedBasePatch.reference_deadwood_label_id || selectedBasePatch.reference_forest_cover_label_id)
  );

  // Any selected patch with available reference data -> show only selected reference layer.
  if (hasReferenceData) {
    return {
      showPredictionDeadwood: false,
      showPredictionForest: false,
      showReferenceDeadwood: layerSelection === "deadwood",
      showReferenceForest: layerSelection === "forest_cover",
    };
  }

  // Base patch with sub-patches but no reference yet -> keep only ortho visible.
  if (isBasePatchSelected && hasSubPatches && !hasReferenceData) {
    return HIDE_ALL_STATE;
  }

  // Reference workflow active but no current reference geometry -> never fall back to predictions.
  if (hasAnyReferenceData) {
    return HIDE_ALL_STATE;
  }

  // Default prediction behavior before reference workflow exists.
  return {
    showPredictionDeadwood: layerSelection === "deadwood",
    showPredictionForest: layerSelection === "forest_cover",
    showReferenceDeadwood: false,
    showReferenceForest: false,
  };
};
