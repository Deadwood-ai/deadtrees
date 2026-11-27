import type { DatasetProgress } from "../../utils/processingSteps";
import { isDatasetProcessingComplete } from "../../utils/processingSteps";
import type { QueueInfo } from "../../hooks/useQueuePositions";

export interface ContributorDataset extends DatasetProgress {
  id: number;
  file_name: string;
  data_access?: "public" | "private" | "viewonly";
  error_stage?: string | null;
  cog_path?: string | null;
  archived?: boolean;
  aquisition_year?: number | null;
  aquisition_month?: number | null;
  aquisition_day?: number | null;
  phenology_probability?: number | null;
}

export type QueueState =
  | { state: "loading" }
  | { state: "error" }
  | { state: "loaded"; item?: QueueInfo };

// Sentence-case stage names; they are read mid-sentence ("stopped during ...").
const stages: Record<string, string> = {
  geotiff: "image preparation",
  geotiff_dependency: "image preparation",
  ortho_processing: "image preparation",
  metadata: "metadata extraction",
  metadata_processing: "metadata extraction",
  cog: "map image preparation",
  cog_processing: "map image preparation",
  thumbnail: "preview generation",
  thumbnail_processing: "preview generation",
  odm_processing: "orthomosaic generation",
  deadwood_segmentation: "deadwood analysis",
  treecover_segmentation: "tree cover analysis",
  forest_cover_segmentation: "tree cover analysis",
  deadwood_treecover_combined_segmentation: "combined AI analysis",
  deadwood_treecover_combined_v2: "combined AI analysis",
  aoi_segmentation: "area selection",
  embedding_processing: "search indexing",
  doy_estimation: "acquisition date estimation",
  georef_check: "georeferencing check",
};

export function stageLabel(stage: string | null | undefined): string | undefined {
  return stage ? stages[stage] : undefined;
}

/** The map image exists, so the owner can open the dataset on the map. */
export function canOpenOwnerMap(dataset: ContributorDataset): boolean {
  return !!(dataset.is_cog_done && dataset.cog_path);
}

export type TagColor = "error" | "warning" | "processing" | "success" | "default";

export interface ProcessingOutcome {
  kind: "failed" | "running" | "checking" | "unavailable" | "queued" | "complete" | "incomplete";
  label: string;
  color: TagColor;
  detail: string;
}

// Only allow-listed stage names reach user copy; the stored stage is an
// internal identifier and is never echoed.
function failurePlace(dataset: ContributorDataset): string {
  const stage = stageLabel(dataset.error_stage);
  if (stage) return `during ${stage}`;
  if (dataset.error_stage) return "at a step this page cannot describe";
  return "at a step that was not recorded";
}

export function processingStatus(dataset: ContributorDataset, queue: QueueState): ProcessingOutcome {
  const mapAvailable = canOpenOwnerMap(dataset);
  if (dataset.has_error) {
    const place = failurePlace(dataset);
    return mapAvailable
      ? {
          kind: "failed",
          label: "Stopped · map available",
          color: "warning",
          detail: `Processing stopped ${place}. The map image was generated before that.`,
        }
      : {
          kind: "failed",
          label: "Processing failed",
          color: "error",
          detail: `Processing stopped ${place}. No map image is available.`,
        };
  }
  if (dataset.current_status && !["idle", "audit_in_progress"].includes(dataset.current_status)) {
    const stage = stageLabel(dataset.current_status);
    return {
      kind: "running",
      label: "Processing",
      color: "processing",
      detail: stage ? `Current step: ${stage}.` : "Processing is running.",
    };
  }
  if (queue.state === "loading") {
    return { kind: "checking", label: "Checking status", color: "default", detail: "Checking the processing queue." };
  }
  if (queue.state === "error") {
    return {
      kind: "unavailable",
      label: "Status unavailable",
      color: "default",
      detail: "The processing queue could not be checked. Refresh to try again.",
    };
  }
  if (queue.item) {
    return {
      kind: "queued",
      label: "Queued",
      color: "processing",
      detail: queue.item.current_position
        ? `Position ${queue.item.current_position} in the processing queue.`
        : "Waiting for a processing worker.",
    };
  }
  // A review lock does not undo completed processing.
  const complete = isDatasetProcessingComplete({
    ...dataset,
    current_status: dataset.current_status === "audit_in_progress" ? "idle" : dataset.current_status,
  });
  if (complete) {
    return { kind: "complete", label: "Results ready", color: "success", detail: "All processing steps completed." };
  }
  return {
    kind: "incomplete",
    label: mapAvailable ? "Incomplete · map available" : "Incomplete",
    color: "warning",
    detail: dataset.is_upload_done
      ? "Some processing steps did not complete and nothing is queued for this dataset."
      : "The upload did not complete and nothing is queued for this dataset.",
  };
}

const GREEN = "#287254";
const AMBER = "#b45309";
const SLATE = "#64748b";

export interface ImageCheck {
  kind: "pending" | "accepted" | "excluded";
  label: string;
  color: string;
}

/** The automated image quality check (the dataset evaluation, audit_decision): an excluded
 * dataset stays in the owner's account but leaves the public map. Null while there is no
 * decision and no map image to check. */
export function imageCheck(dataset: ContributorDataset): ImageCheck | null {
  switch (dataset.audit_decision) {
    case "exclude":
      return { kind: "excluded", label: "Excluded from public map", color: AMBER };
    case "keep":
      return { kind: "accepted", label: "Image accepted", color: GREEN };
    default:
      return canOpenOwnerMap(dataset) ? { kind: "pending", label: "Image check pending", color: SLATE } : null;
  }
}

/** True when the contributor should read the details before relying on this dataset. */
export function needsAttention(processing: ProcessingOutcome, check: ImageCheck | null): boolean {
  return processing.kind === "failed" || processing.kind === "incomplete" || check?.kind === "excluded";
}

export interface StatusSummary {
  /** One or two sentences answering "what happened" and "what exists". */
  headline: string;
  /** What the contributor can do now, or null when nothing is expected of them. */
  next: string | null;
}

// The summary only states what the stored fields prove. It never promises a
// retry or a follow-up.
export function statusSummary(dataset: ContributorDataset, queue: QueueState): StatusSummary {
  const processing = processingStatus(dataset, queue);
  const contact = `If you need help with this dataset, contact the DeadTrees team and include dataset ${dataset.id}.`;
  const exclusion =
    dataset.audit_decision === "exclude"
      ? " The image did not pass the quality check, so it is not on the public map. It stays in your account."
      : "";

  switch (processing.kind) {
    case "failed":
    case "incomplete":
      return { headline: processing.detail + exclusion, next: contact };
    case "running":
      return { headline: processing.detail + exclusion, next: "Nothing to do while it runs." };
    case "queued":
      return { headline: processing.detail + exclusion, next: "Nothing to do while it waits." };
    case "checking":
    case "unavailable":
      return { headline: processing.detail, next: null };
    case "complete":
      return { headline: processing.detail + exclusion, next: null };
  }
}
