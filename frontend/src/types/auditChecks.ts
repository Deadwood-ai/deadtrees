/** Rows of the automated audit checks (audit schema, docs/audit-checks.md). */

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
  major_likelihood: number | null;
  modes: Record<string, unknown>;
  reason_code: string | null;
  reason_text: string | null;
  details: Record<string, unknown>;
  imported_from: string | null;
  created_at: string;
  /** a person's email, added by the page for auditors */
  assessor_email?: string | null;
}

/** One row of audit.review_queue: a dataset, check and layer, and whether a person must look. */
export interface IAuditQueueRow {
  dataset_id: number;
  check_key: AuditCheckKey;
  layer: AuditLayer;
  run_id: number;
  version: string;
  mode: "review_all" | "review_uncertain" | "auto_apply";
  verdict: AuditVerdict;
  verdicts: Record<string, AuditVerdict>;
  needs_review: boolean;
  reason: "review_all" | "unsure" | "models_disagree" | "spot_check" | null;
  reviewed: boolean;
}

export interface IAuditRun {
  id: number;
  check_key: AuditCheckKey;
  status: "queued" | "running" | "done" | "failed";
  inputs: Record<string, unknown>;
  evidence: Record<string, unknown>;
  coverage: Record<string, unknown>;
  finished_at: string | null;
}

export interface IAuditCrop {
  id: number;
  crop_sets: string[];
  geometry: GeoJSON.Polygon;
  mpp: number;
  size_px: number;
  selection: Record<string, unknown>;
}

export type AuditImageKind = "raw" | "deadwood_overlay" | "forest_cover_overlay" | "overview" | "thumbnail";

export interface IAuditImage {
  id: number;
  crop_id: number | null;
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
  /** false while the audit schema cannot be read (not exposed, or not an auditor) */
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
}
