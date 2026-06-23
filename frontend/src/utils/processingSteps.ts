export interface ProcessingStep {
  key: string;
  label: string;
  description: string;
}

export const GEOTIFF_PROCESSING_STEPS: ProcessingStep[] = [
  // Existing steps for GeoTIFF uploads
  { key: "upload", label: "Uploading", description: "Uploading your data to the platform" },
  { key: "ortho", label: "Processing Image", description: "Processing and validating your orthophoto" },
  { key: "metadata", label: "Extracting Information", description: "Extracting geographic and technical metadata" },
  { key: "cog", label: "Optimizing Data", description: "Converting to optimized format for visualization" },
  { key: "deadwood", label: "AI Analysis", description: "Running AI analysis for deadwood cover detection" },
  { key: "treecover", label: "Tree cover analysis", description: "Running AI analysis for tree cover segmentation" },
];

export const RAW_IMAGES_PROCESSING_STEPS: ProcessingStep[] = [
  // New workflow for raw drone images
  { key: "upload", label: "Uploading", description: "Uploading your raw drone images" },
  { key: "odm_processing", label: "ODM Processing", description: "Creating orthomosaic from raw drone images" },
  { key: "ortho", label: "Processing Image", description: "Processing and validating your orthophoto" },
  { key: "metadata", label: "Extracting Information", description: "Extracting geographic and technical metadata" },
  { key: "cog", label: "Optimizing Data", description: "Converting to optimized format for visualization" },
  { key: "deadwood", label: "AI Analysis", description: "Running AI analysis for deadwood cover detection" },
  { key: "treecover", label: "Tree cover analysis", description: "Running AI analysis for tree cover segmentation" },
];

const COMBINED_MODEL_STEP: ProcessingStep = {
  key: "combined_model",
  label: "Combined AI Analysis",
  description: "Running combined deadwood cover and tree cover model",
};

const AOI_STEP: ProcessingStep = {
  key: "aoi",
  label: "Area selection",
  description: "Generating an initial area of interest for audit",
};

const EMBEDDINGS_STEP: ProcessingStep = {
  key: "embeddings",
  label: "Search indexing",
  description: "Computing open-vocabulary embeddings for tile search",
};

const COMBINED_MODEL_STATUS = "deadwood_treecover_combined_segmentation";
const AOI_STATUS = "aoi_segmentation";
const EMBEDDING_STATUS = "embedding_processing";

function isOdmWorkflow(dataset: DatasetProgress): boolean {
  return dataset.file_name?.toLowerCase().endsWith(".zip") || false;
}

export interface DatasetProgress {
  file_name?: string;
  is_upload_done?: boolean;
  is_odm_done?: boolean;
  is_ortho_done?: boolean;
  is_metadata_done?: boolean;
  is_cog_done?: boolean;
  is_deadwood_done?: boolean;
  is_forest_cover_done?: boolean;
  is_combined_model_done?: boolean;
  is_aoi_done?: boolean;
  is_aoi_required?: boolean;
  // Open-vocabulary tile embeddings run as the final stage for every new upload.
  // current_status may now be "embedding_processing" while this stage runs.
  is_embeddings_done?: boolean;
  has_error?: boolean;
  current_status?: string;
  final_assessment?: "ready" | "fixable_issues" | "no_issues" | "exclude_completely" | null;
  audit_date?: string | null;
  deadwood_quality?: "great" | "sentinel_ok" | "bad" | null;
  forest_cover_quality?: "great" | "sentinel_ok" | "bad" | null;
  has_valid_phenology?: boolean | null;
  has_valid_acquisition_date?: boolean | null;
}

function isDeadwoodProcessingComplete(dataset: DatasetProgress): boolean {
  return !!dataset.is_deadwood_done;
}

function isTreecoverProcessingComplete(dataset: DatasetProgress): boolean {
  return !!dataset.is_forest_cover_done;
}

export function isLegacyPredictionProcessingComplete(
  dataset: DatasetProgress,
): boolean {
  return (
    isDeadwoodProcessingComplete(dataset) &&
    isTreecoverProcessingComplete(dataset)
  );
}

export function isPredictionProcessingComplete(
  dataset: DatasetProgress,
): boolean {
  return (
    isLegacyPredictionProcessingComplete(dataset) ||
    !!dataset.is_combined_model_done
  );
}

export function isDatasetProcessingComplete(dataset: DatasetProgress): boolean {
  const odmComplete = !isOdmWorkflow(dataset) || dataset.is_odm_done;
  // Any non-idle status blocks completion, which now also covers the final
  // "embedding_processing" stage. We intentionally do NOT require
  // is_embeddings_done while idle: existing datasets predate the embeddings
  // stage and would otherwise never read as complete.
  const hasActiveProcessingStatus =
    !!dataset.current_status && dataset.current_status !== "idle";

  return !!(
    !dataset.has_error &&
    !hasActiveProcessingStatus &&
    dataset.is_upload_done &&
    odmComplete &&
    dataset.is_ortho_done &&
    dataset.is_metadata_done &&
    dataset.is_cog_done &&
    isPredictionProcessingComplete(dataset) &&
    (!dataset.is_aoi_required || dataset.is_aoi_done)
  );
}

export function calculateProcessingProgress(dataset: DatasetProgress): {
  currentStep: number;
  totalSteps: number;
  percentage: number;
  currentStepInfo: ProcessingStep;
  isComplete: boolean;
} {
  // Determine if this is an ODM workflow (raw images) based on file extension
  const isOdmDataset = isOdmWorkflow(dataset);
  const hasExplicitLegacyPredictionOutput =
    !!dataset.is_deadwood_done || !!dataset.is_forest_cover_done;
  const includeCombinedModelStep =
    dataset.is_combined_model_done ||
    dataset.current_status === COMBINED_MODEL_STATUS;
  const includeAoiStep =
    dataset.is_aoi_required ||
    dataset.is_aoi_done ||
    dataset.current_status === AOI_STATUS;
  // Only surface the embeddings step once the dataset is on the new pipeline
  // (actively embedding or already done), so existing datasets that predate the
  // stage keep their previous step count and complete state.
  const includeEmbeddingsStep =
    dataset.is_embeddings_done ||
    dataset.current_status === EMBEDDING_STATUS;
  const useCombinedModelOnly =
    includeCombinedModelStep && !hasExplicitLegacyPredictionOutput;
  let steps = useCombinedModelOnly
    ? [
        ...(isOdmDataset
          ? RAW_IMAGES_PROCESSING_STEPS
          : GEOTIFF_PROCESSING_STEPS
        ).slice(0, -2),
        COMBINED_MODEL_STEP,
      ]
    : includeCombinedModelStep
      ? [
          ...(isOdmDataset
            ? RAW_IMAGES_PROCESSING_STEPS
            : GEOTIFF_PROCESSING_STEPS),
          COMBINED_MODEL_STEP,
        ]
      : isOdmDataset
        ? RAW_IMAGES_PROCESSING_STEPS
        : GEOTIFF_PROCESSING_STEPS;
  if (includeAoiStep) {
    steps = [...steps, AOI_STEP];
  }
  if (includeEmbeddingsStep) {
    steps = [...steps, EMBEDDINGS_STEP];
  }
  const totalSteps = steps.length;

  // If there's an error, return error state
  if (dataset.has_error) {
    return {
      currentStep: 0,
      totalSteps,
      percentage: 0,
      currentStepInfo: steps[0],
      isComplete: false,
    };
  }

  const baseStepCompletions = [
    dataset.is_upload_done || false,
    ...(isOdmDataset ? [dataset.is_odm_done || false] : []), // ODM step only for raw images
    dataset.is_ortho_done || false,
    dataset.is_metadata_done || false,
    dataset.is_cog_done || false,
  ];

  // Check completion status for each step.
  let stepCompletions = useCombinedModelOnly
    ? [...baseStepCompletions, dataset.is_combined_model_done || false]
    : includeCombinedModelStep
      ? [
          ...baseStepCompletions,
          isDeadwoodProcessingComplete(dataset),
          isTreecoverProcessingComplete(dataset),
          dataset.is_combined_model_done || false,
        ]
      : [
          ...baseStepCompletions,
          isDeadwoodProcessingComplete(dataset),
          isTreecoverProcessingComplete(dataset),
        ];
  if (includeAoiStep) {
    stepCompletions = [...stepCompletions, dataset.is_aoi_done || false];
  }
  if (includeEmbeddingsStep) {
    stepCompletions = [...stepCompletions, dataset.is_embeddings_done || false];
  }

  // Find the current step (first incomplete step)
  const currentStep = stepCompletions.findIndex((completed) => !completed);

  // If all steps are complete
  if (currentStep === -1) {
    return {
      currentStep: totalSteps,
      totalSteps,
      percentage: 100,
      currentStepInfo: steps[totalSteps - 1],
      isComplete: true,
    };
  }

  // Calculate percentage based on completed steps
  const completedSteps = stepCompletions.filter(Boolean).length;
  const percentage = Math.round((completedSteps / totalSteps) * 100);

  return {
    currentStep: currentStep + 1, // 1-based for display
    totalSteps,
    percentage,
    currentStepInfo: steps[currentStep],
    isComplete: false,
  };
}
