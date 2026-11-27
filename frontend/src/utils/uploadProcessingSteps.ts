import { UploadType } from "../types/dataset";

// The processing stages a contributor upload starts with, by upload type.
const PREDICTION_PROCESSING_STEPS = [
  "deadwood_v1",
  "treecover_v1",
  "deadwood_treecover_combined_v2",
];

const GEOTIFF_PROCESSING_STEPS = [
  "geotiff",
  "cog",
  "thumbnail",
  "metadata",
  "aoi_v1",
  ...PREDICTION_PROCESSING_STEPS,
  // Open-vocabulary tile embeddings run last (needs the standardized ortho).
  "embeddings_v1",
  // Acquisition-date estimate + audit prefill (reads the stored COG and AOI).
  "doy_estimation_v1",
  // Georeferencing offset against satellite imagery + audit prefill (reads the stored COG and AOI).
  "georef_check_v1",
];

const RAW_IMAGES_PROCESSING_STEPS = [
  "odm_processing",
  ...GEOTIFF_PROCESSING_STEPS,
];

export const processingStepsFor = (uploadType: string): string[] =>
  uploadType === UploadType.RAW_IMAGES_ZIP ? RAW_IMAGES_PROCESSING_STEPS : GEOTIFF_PROCESSING_STEPS;
