/** Rows of the automated audit checks (audit schema, docs/audit-checks.md), with the columns the audit page reads. */

export type AuditVerdict = "ok" | "minor" | "major" | "unsure";
export type AuditCheckKey = "dataset_evaluation" | "georef" | "acquisition_date" | "prediction_quality";
export type AuditLayer = "image" | "deadwood" | "forest_cover" | "georef" | "acquisition_date" | "phenology";

/** One row of audit.assessments (or its latest/current views). */
export interface IAuditAssessment {
  id: number;
  check_key: AuditCheckKey;
  dataset_id: number;
  crop_id: number | null;
  run_id: number | null;
  layer: AuditLayer;
  label_id: number | null;
  assessor_kind: "person" | "model" | "rule";
  assessor_user_id: string | null;
  model: string | null;
  prompt_version: string | null;
  /** user id, or model/prompt_version */
  assessor: string;
  verdict: AuditVerdict;
  /** a model's likelihood (0-100) that the target has major errors; null for people and rules */
  major_likelihood?: number | null;
  reason_code: string | null;
  reason_text: string | null;
  details: Record<string, unknown>;
  /** a person's email, added by the page for auditors */
  assessor_email?: string | null;
}

/** One row of audit.review_queue: a dataset, check and layer with a dataset-level call. */
export interface IAuditQueueRow {
  dataset_id: number;
  check_key: AuditCheckKey;
  layer: AuditLayer;
  run_id: number;
  verdict: AuditVerdict;
  /** why the result goes to a person; null when the version's mode applies it without review */
  reason: "review_all" | "unsure" | "models_disagree" | "spot_check" | null;
}

export interface IAuditRun {
  id: number;
  check_key: AuditCheckKey;
  /** what the run judged, e.g. ortho_sha256 */
  inputs: Record<string, unknown>;
  /** what the run found; `judged` names its own crops and the image files that differ from the stored rows */
  evidence: Record<string, unknown>;
  /** the check version the run ran with: its config holds the rule's cut-offs */
  version?: { config: Record<string, unknown> } | null;
}

export interface IAuditCrop {
  id: number;
  /** identifies the ortho version the crop was cut from */
  ortho_sha256: string;
  crop_sets: string[];
  geometry: GeoJSON.Polygon;
}

export type AuditImageKind = "raw" | "deadwood_overlay" | "forest_cover_overlay" | "overview" | "thumbnail";

export interface IAuditImage {
  id: number;
  ortho_sha256: string;
  crop_id: number | null;
  /** the prediction an overlay shows; null for raw crops, overviews and thumbnails */
  label_id: number | null;
  kind: AuditImageKind;
  storage_path: string;
  width: number;
  height: number;
}

/** Everything one check holds for a dataset: its current run and what was judged. */
export interface IAuditCheckEvidence {
  run: IAuditRun;
  /** model and rule rows of the current run, dataset level and per crop */
  automated: IAuditAssessment[];
  queue: IAuditQueueRow[];
  crops: IAuditCrop[];
  images: IAuditImage[];
}

export interface IAuditChecks {
  /** false while the audit schema cannot be read (not exposed on this server) */
  available: boolean;
  checks: Partial<Record<AuditCheckKey, IAuditCheckEvidence>>;
  /** native person rows on the dataset, latest per target, layer and person */
  people: IAuditAssessment[];
}

/** A person's answer to a check, as the review page stores it. */
export interface IAuditAnswerInput {
  check_key: AuditCheckKey;
  dataset_id: number;
  run_id: number;
  layer: AuditLayer;
  crop_id?: number | null;
  label_id?: number | null;
  verdict: AuditVerdict;
  reason_code?: string | null;
  reason_text?: string | null;
  /** what the reviewer adds to the verdict, e.g. the dataset evaluation's fix_flags */
  details?: Record<string, unknown>;
}
