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
  { key: "deadwood", label: "AI Analysis", description: "Running AI analysis for deadwood detection" },
  { key: "treecover", label: "Tree Cover Analysis", description: "Running AI analysis for tree cover segmentation" },
];

export const RAW_IMAGES_PROCESSING_STEPS: ProcessingStep[] = [
  // New workflow for raw drone images
  { key: "upload", label: "Uploading", description: "Uploading your raw drone images" },
  { key: "odm_processing", label: "ODM Processing", description: "Creating orthomosaic from raw drone images" },
  { key: "ortho", label: "Processing Image", description: "Processing and validating your orthophoto" },
  { key: "metadata", label: "Extracting Information", description: "Extracting geographic and technical metadata" },
  { key: "cog", label: "Optimizing Data", description: "Converting to optimized format for visualization" },
  { key: "deadwood", label: "AI Analysis", description: "Running AI analysis for deadwood detection" },
  { key: "treecover", label: "Tree Cover Analysis", description: "Running AI analysis for tree cover segmentation" },
];

export interface DatasetProgress {
  file_name?: string;
  is_upload_done?: boolean;
  is_odm_done?: boolean;
  is_ortho_done?: boolean;
  is_metadata_done?: boolean;
  is_cog_done?: boolean;
  is_deadwood_done?: boolean;
  is_forest_cover_done?: boolean;
  has_error?: boolean;
  current_status?: string;
  final_assessment?: "ready" | "fixable_issues" | "no_issues" | "exclude_completely" | null;
  audit_date?: string | null;
  deadwood_quality?: "great" | "sentinel_ok" | "bad" | null;
  forest_cover_quality?: "great" | "sentinel_ok" | "bad" | null;
  has_valid_phenology?: boolean | null;
  has_valid_acquisition_date?: boolean | null;
}

/**
 * Smart detection for when deadwood processing is actually complete
 * even when is_deadwood_done = false (no deadwood found case)
 */
function isDeadwoodProcessingComplete(dataset: DatasetProgress): boolean {
  // If is_deadwood_done is already true, processing is definitely complete
  if (dataset.is_deadwood_done) {
    return true;
  }

  // If all previous steps are done, status is idle, and no errors,
  // assume deadwood processing completed (just found no results)
  const odmComplete = dataset.is_odm_done === undefined || dataset.is_odm_done;
  return !!(
    dataset.is_upload_done &&
    odmComplete &&
    dataset.is_ortho_done &&
    dataset.is_metadata_done &&
    dataset.is_cog_done &&
    !dataset.has_error &&
    dataset.current_status === "idle"
  );
}

/**
 * Smart detection for when treecover processing is actually complete
 * even when is_forest_cover_done = false (no tree cover found case)
 */
function isTreecoverProcessingComplete(dataset: DatasetProgress): boolean {
  // If is_forest_cover_done is already true, processing is definitely complete
  if (dataset.is_forest_cover_done) {
    return true;
  }

  // If all previous steps are done, status is idle, and no errors,
  // assume treecover processing completed (just found no results)
  return !!(
    dataset.is_upload_done &&
    dataset.is_ortho_done &&
    dataset.is_metadata_done &&
    dataset.is_cog_done &&
    isDeadwoodProcessingComplete(dataset) &&
    !dataset.has_error &&
    dataset.current_status === "idle"
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
  const isOdmWorkflow = dataset.file_name?.toLowerCase().endsWith(".zip") || false;
  const steps = isOdmWorkflow ? RAW_IMAGES_PROCESSING_STEPS : GEOTIFF_PROCESSING_STEPS;
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

  // Check completion status for each step with smart detection
  const stepCompletions = [
    dataset.is_upload_done || false,
    ...(isOdmWorkflow ? [dataset.is_odm_done || false] : []), // ODM step only for raw images
    dataset.is_ortho_done || false,
    dataset.is_metadata_done || false,
    dataset.is_cog_done || false,
    isDeadwoodProcessingComplete(dataset), // Smart deadwood completion check
    isTreecoverProcessingComplete(dataset), // Smart treecover completion check
  ];

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
