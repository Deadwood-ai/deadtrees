import { useDatasetLabels } from "./useDatasetLabels";
import { ILabelData } from "../types/labels";

interface UseDatasetLabelTypesProps {
  datasetId: number | undefined;
  enabled?: boolean;
}

/**
 * Modular hook to fetch multiple label types for a dataset
 * Reduces duplication and provides consistent loading states
 */
export function useDatasetLabelTypes({ datasetId, enabled = true }: UseDatasetLabelTypesProps) {
  // Fetch deadwood labels
  const {
    data: deadwoodLabels,
    isLoading: isLoadingDeadwood,
    error: deadwoodError,
  } = useDatasetLabels({
    datasetId,
    labelData: ILabelData.DEADWOOD,
    enabled: enabled && !!datasetId,
  });

  // Fetch forest cover labels
  const {
    data: forestCoverLabels,
    isLoading: isLoadingForestCover,
    error: forestCoverError,
  } = useDatasetLabels({
    datasetId,
    labelData: ILabelData.FOREST_COVER,
    enabled: enabled && !!datasetId,
  });

  return {
    deadwood: {
      data: deadwoodLabels,
      isLoading: isLoadingDeadwood,
      error: deadwoodError,
    },
    forestCover: {
      data: forestCoverLabels,
      isLoading: isLoadingForestCover,
      error: forestCoverError,
    },
    // Combined loading state
    isLoading: isLoadingDeadwood || isLoadingForestCover,
    // Check if any data is available
    hasAnyData: !!deadwoodLabels || !!forestCoverLabels,
  };
}
