import { describe, expect, it } from "vitest";
import { IDataAccess } from "../types/dataset";
import { canDownloadCompleteDataset } from "./datasetDownloads";
import type { DatasetProgress } from "./processingSteps";

const completeDataset: DatasetProgress & { data_access: IDataAccess } = {
  file_name: "complete.tif",
  data_access: IDataAccess.public,
  current_status: "idle",
  has_error: false,
  is_upload_done: true,
  is_ortho_done: true,
  is_metadata_done: true,
  is_cog_done: true,
  is_deadwood_done: true,
  is_forest_cover_done: true,
  is_combined_model_done: false,
};

describe("canDownloadCompleteDataset", () => {
  it("allows complete public datasets", () => {
    expect(canDownloadCompleteDataset(completeDataset)).toBe(true);
  });

  it("blocks errored datasets", () => {
    expect(canDownloadCompleteDataset({ ...completeDataset, has_error: true })).toBe(false);
  });

  it("blocks datasets with active processing status", () => {
    expect(canDownloadCompleteDataset({ ...completeDataset, current_status: "cog_processing" })).toBe(false);
  });

  it("allows completed datasets while an audit is in progress", () => {
    expect(canDownloadCompleteDataset({ ...completeDataset, current_status: "audit_in_progress" })).toBe(true);
  });

  it("blocks incomplete datasets", () => {
    expect(canDownloadCompleteDataset({ ...completeDataset, is_cog_done: false })).toBe(false);
  });

  it("blocks view-only datasets from full archive downloads", () => {
    expect(canDownloadCompleteDataset({ ...completeDataset, data_access: IDataAccess.viewonly })).toBe(false);
  });
});
