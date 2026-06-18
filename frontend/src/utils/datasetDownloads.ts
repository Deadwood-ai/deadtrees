import { IDataAccess, type IDataset } from "../types/dataset";
import {
  isPredictionProcessingComplete,
  type DatasetProgress,
} from "./processingSteps";

type DatasetDownloadStatus = DatasetProgress & Pick<IDataset, "data_access">;
const FULL_DOWNLOAD_ALLOWED_STATUSES = new Set([undefined, "", "idle", "audit_in_progress"]);

function isOdmWorkflow(dataset: DatasetProgress): boolean {
  return dataset.file_name?.toLowerCase().endsWith(".zip") || false;
}

export function canDownloadCompleteDataset(dataset: DatasetDownloadStatus): boolean {
  const odmComplete = !isOdmWorkflow(dataset) || dataset.is_odm_done;
  return !!(
    dataset.data_access !== IDataAccess.viewonly &&
    !dataset.has_error &&
    FULL_DOWNLOAD_ALLOWED_STATUSES.has(dataset.current_status) &&
    dataset.is_upload_done &&
    odmComplete &&
    dataset.is_ortho_done &&
    dataset.is_metadata_done &&
    dataset.is_cog_done &&
    isPredictionProcessingComplete(dataset)
  );
}
