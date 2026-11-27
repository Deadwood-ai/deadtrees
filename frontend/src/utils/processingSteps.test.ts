import { describe, expect, it } from "vitest";
import {
  calculateProcessingProgress,
  isDatasetProcessingComplete,
  processingToast,
  type DatasetProgress,
} from "./processingSteps";

const completeCore: DatasetProgress = {
  file_name: "legacy.tif",
  current_status: "idle",
  has_error: false,
  is_upload_done: true,
  is_ortho_done: true,
  is_metadata_done: true,
  is_cog_done: true,
  is_thumbnail_done: true,
  is_odm_done: false,
  is_aoi_done: false,
  is_aoi_required: false,
};

describe("processing step completion", () => {
  it("treats legacy deadwood and tree-cover outputs as complete without combined model output", () => {
    const dataset: DatasetProgress = {
      ...completeCore,
      is_deadwood_done: true,
      is_forest_cover_done: true,
      is_combined_model_done: false,
    };

    expect(isDatasetProcessingComplete(dataset)).toBe(true);
    expect(calculateProcessingProgress(dataset)).toMatchObject({
      isComplete: true,
      percentage: 100,
      totalSteps: 6,
    });
  });

  it("keeps the combined model step visible while it is actively running after legacy outputs", () => {
    const dataset: DatasetProgress = {
      ...completeCore,
      current_status: "deadwood_treecover_combined_segmentation",
      is_deadwood_done: true,
      is_forest_cover_done: true,
      is_combined_model_done: false,
    };

    const progress = calculateProcessingProgress(dataset);

    expect(isDatasetProcessingComplete(dataset)).toBe(false);
    expect(progress.isComplete).toBe(false);
    expect(progress.currentStepInfo.key).toBe("combined_model");
    expect(progress.totalSteps).toBe(7);
  });

  it("treats combined-model-only outputs as complete", () => {
    const dataset: DatasetProgress = {
      ...completeCore,
      is_deadwood_done: false,
      is_forest_cover_done: false,
      is_combined_model_done: true,
    };

    expect(isDatasetProcessingComplete(dataset)).toBe(true);
    expect(calculateProcessingProgress(dataset)).toMatchObject({
      isComplete: true,
      percentage: 100,
      totalSteps: 5,
    });
  });

  it("keeps the AOI step visible while it is actively running after predictions", () => {
    const dataset: DatasetProgress = {
      ...completeCore,
      current_status: "aoi_segmentation",
      is_deadwood_done: false,
      is_forest_cover_done: false,
      is_combined_model_done: true,
      is_aoi_done: false,
      is_aoi_required: true,
    };

    const progress = calculateProcessingProgress(dataset);

    expect(isDatasetProcessingComplete(dataset)).toBe(false);
    expect(progress.isComplete).toBe(false);
    expect(progress.currentStepInfo.key).toBe("aoi");
    expect(progress.totalSteps).toBe(6);
  });

  it("does not complete after predictions while AOI is still pending", () => {
    const dataset: DatasetProgress = {
      ...completeCore,
      is_deadwood_done: false,
      is_forest_cover_done: false,
      is_combined_model_done: true,
      is_aoi_done: false,
      is_aoi_required: true,
    };

    const progress = calculateProcessingProgress(dataset);

    expect(isDatasetProcessingComplete(dataset)).toBe(false);
    expect(progress.isComplete).toBe(false);
    expect(progress.currentStepInfo.key).toBe("aoi");
    expect(progress.totalSteps).toBe(6);
  });

  it("does not complete predictions without a legacy or combined prediction signal", () => {
    const dataset: DatasetProgress = {
      ...completeCore,
      is_deadwood_done: false,
      is_forest_cover_done: false,
      is_combined_model_done: false,
    };

    const progress = calculateProcessingProgress(dataset);

    expect(isDatasetProcessingComplete(dataset)).toBe(false);
    expect(progress.isComplete).toBe(false);
    expect(progress.currentStepInfo.key).toBe("deadwood");
  });

  it("does not complete until the user-visible thumbnail is ready", () => {
    const dataset: DatasetProgress = {
      ...completeCore,
      is_thumbnail_done: false,
      is_deadwood_done: true,
      is_forest_cover_done: true,
    };

    expect(isDatasetProcessingComplete(dataset)).toBe(false);
  });

  it("keeps an existing dataset complete without the embeddings stage", () => {
    // Datasets uploaded before the embeddings_v1 stage never run it and default
    // is_embeddings_done=false; they must still read as complete.
    const dataset: DatasetProgress = {
      ...completeCore,
      is_deadwood_done: true,
      is_forest_cover_done: true,
      is_embeddings_done: false,
    };

    expect(isDatasetProcessingComplete(dataset)).toBe(true);
    expect(calculateProcessingProgress(dataset)).toMatchObject({
      isComplete: true,
      totalSteps: 6,
    });
  });

  it("does not complete while the embeddings stage is actively running", () => {
    const dataset: DatasetProgress = {
      ...completeCore,
      current_status: "embedding_processing",
      is_deadwood_done: true,
      is_forest_cover_done: true,
      is_embeddings_done: false,
    };

    const progress = calculateProcessingProgress(dataset);

    expect(isDatasetProcessingComplete(dataset)).toBe(false);
    expect(progress.isComplete).toBe(false);
    expect(progress.currentStepInfo.key).toBe("embeddings");
    expect(progress.totalSteps).toBe(7);
  });

  it("completes once the embeddings stage is done", () => {
    const dataset: DatasetProgress = {
      ...completeCore,
      is_deadwood_done: true,
      is_forest_cover_done: true,
      is_embeddings_done: true,
    };

    expect(isDatasetProcessingComplete(dataset)).toBe(true);
    expect(calculateProcessingProgress(dataset)).toMatchObject({
      isComplete: true,
      percentage: 100,
      totalSteps: 7,
    });
  });

  it("requires ODM completion only for raw image ZIP workflows", () => {
    const dataset: DatasetProgress = {
      ...completeCore,
      file_name: "raw-images.zip",
      is_deadwood_done: true,
      is_forest_cover_done: true,
      is_odm_done: false,
    };

    expect(isDatasetProcessingComplete(dataset)).toBe(false);
    expect(isDatasetProcessingComplete({ ...dataset, is_odm_done: true })).toBe(true);
  });
});

describe("processing toast", () => {
  const done: DatasetProgress = { ...completeCore, is_combined_model_done: true };

  it("says complete when a stage the uploader sees finishes the processing", () => {
    expect(processingToast({ current_status: "deadwood_treecover_combined_segmentation", has_error: false }, done)).toBe("complete");
  });

  it("says nothing after an audit-only run, an idle update or the first update the session sees", () => {
    expect(processingToast({ current_status: "georef_check", has_error: false }, done)).toBeNull();
    expect(processingToast({ current_status: "doy_estimation", has_error: false }, done)).toBeNull();
    expect(processingToast({ current_status: "idle", has_error: false }, done)).toBeNull();
    expect(processingToast(undefined, done)).toBeNull();
  });

  it("says failed for a new error, not for an audit stage's or one already seen", () => {
    const failed = { ...done, has_error: true };
    expect(processingToast({ current_status: "cog_processing", has_error: false }, { ...failed, current_status: "cog_processing" })).toBe("failed");
    expect(processingToast({ current_status: "georef_check", has_error: false }, failed)).toBeNull();
    expect(processingToast({ current_status: "idle", has_error: false }, { ...failed, current_status: "georef_check" })).toBeNull();
    expect(processingToast({ current_status: "idle", has_error: true }, failed)).toBeNull();
  });
});
