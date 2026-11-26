/** Rows of the automated audit checks (audit schema, docs/audit-checks.md), with the columns the audit page reads. */

/** ambiguous: a person's answer on a crop's prediction layer when people cannot reliably tell (shrub
 * or tree, an unusual dieback) */
export type AuditVerdict = "ok" | "minor" | "major" | "unsure" | "ambiguous";
export type AuditCheckKey = "dataset_evaluation" | "georef" | "acquisition_date" | "prediction_quality";
export type AuditLayer = "image" | "deadwood" | "forest_cover" | "georef" | "acquisition_date" | "phenology";

/** One row of audit.assessments (or its latest/current views). */
export interface IAuditAssessment {
  id: number;
  /** when the row was written */
  created_at?: string;
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
  /** required on dataset evaluation rows and crop rows; other dataset-level rows report `output` instead */
  verdict: AuditVerdict | null;
  /** what the check (or a person's answer) reports on the dataset, e.g. georeferencing {status, offset_m} */
  output?: Record<string, unknown> | null;
  /** a model's likelihood (0-100) that the target has major errors; null for people and rules */
  major_likelihood?: number | null;
  /** error types on the target: a model gives each its likelihood (0-100) and the share of the
   * target it covers (area_pct, 0-100); a person tags the ones they saw with true */
  modes?: Record<string, IModeScore | true> | null;
  reason_code: string | null;
  reason_text: string | null;
  details: Record<string, unknown>;
  /** a person's email, added by the page for auditors */
  assessor_email?: string | null;
}

/** A model's score for one error type. */
export interface IModeScore {
  likelihood?: number;
  area_pct?: number;
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
  /** read where images of several datasets are loaded at once (the benchmark) */
  dataset_id?: number;
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
  /** the run whose results the person judged; null for a benchmark label on a target no run judged (a gold crop) */
  run_id: number | null;
  layer: AuditLayer;
  crop_id?: number | null;
  label_id?: number | null;
  /** required on dataset evaluation and crop answers, null on the other dataset-level answers */
  verdict?: AuditVerdict | null;
  /** the answer's output values, e.g. georeferencing {status: "passed"} or the date {replace: false} */
  output?: Record<string, unknown> | null;
  reason_code?: string | null;
  reason_text?: string | null;
  /** the error types the reviewer saw, tagged true (docs/audit-checks.md: people store tags) */
  modes?: Record<string, true>;
  /** what the reviewer adds to the verdict, e.g. the dataset evaluation's fix_flags or a crop's unsure_modes */
  details?: Record<string, unknown>;
}

/** An open benchmark version and its targets (audit.benchmarks, audit.benchmark_members). */
export interface IAuditBenchmark {
  id: number;
  check_key: AuditCheckKey;
  /** the prediction layer a crop benchmark scores; null for the dataset evaluation */
  layer: "deadwood" | "forest_cover" | null;
  name: string;
  version: string;
}

/** Which benchmark: a check and, for prediction quality, the layer. */
export type BenchmarkRef = Pick<IAuditBenchmark, "check_key" | "layer">;

/** One target of a benchmark: a crop (prediction quality) or a whole dataset (dataset evaluation),
 * with what a labeler needs to judge it. */
export interface IBenchmarkTarget {
  /** the member row; a random new target not in the benchmark yet has a negative id */
  id: number;
  dataset_id: number;
  crop_id: number | null;
  /** null until the target joins the benchmark */
  split: "dev" | "holdout" | null;
  /** in the benchmark: a random new target joins once its label is stored */
  member: boolean;
  /** the run a label carries: the check's current run when it judged the target, else null (a gold crop) */
  run_id: number | null;
  /** the stored images: for a crop its raw image and overlays, for a dataset its overview,
   * thumbnail and evaluation crops */
  images: IAuditImage[];
  /** the target's label: the latest native person row per layer, whoever gave it */
  people: IAuditAssessment[];
  /** model and rule rows, latest per assessor and layer */
  models: IAuditAssessment[];
}

export interface IBenchmarkData {
  benchmark: IAuditBenchmark;
  targets: IBenchmarkTarget[];
}

/** What a person still has to look at on a dataset (audit.dataset_results.review_required), in page order. */
export type ReviewItem = "evaluation" | "aoi" | "georef" | "date";
export type EvaluationDecision = "ok" | "exclude";
export type GeorefStatus = "estimated" | "no_reference" | "needs_review" | "passed" | "not_passed";

/** One row of audit.dataset_results: every dataset with each check's output, whether a person
 * still has to review it and where the values come from (docs/audit-checks.md). */
export interface IAuditDatasetResult {
  dataset_id: number;
  current_status: string | null;
  is_processing_done: boolean;
  evaluation_decision: EvaluationDecision | null;
  evaluation_source: "reviewer" | "legacy" | "check" | null;
  cog_issue: boolean | null;
  thumbnail_issue: boolean | null;
  aoi_exists: boolean;
  aoi_created_at: string | null;
  aoi_source: string | null;
  aoi_model_version: string | null;
  georef_status: GeorefStatus | null;
  georef_offset_m: number | null;
  georef_source: "reviewer" | "check" | null;
  date_replace: boolean | null;
  date_new: string | null;
  date_predicted: string | null;
  date_hdi80_days: number | null;
  date_model_version: string | null;
  date_estimated_at: string | null;
  date_source: string | null;
  phenology_probability: number | null;
  deadwood_total: number | null;
  deadwood_major: number | null;
  deadwood_minor: number | null;
  deadwood_ok: number | null;
  forest_cover_total: number | null;
  forest_cover_major: number | null;
  forest_cover_minor: number | null;
  forest_cover_ok: number | null;
  review_required: ReviewItem[];
  last_reviewed_at: string | null;
  in_benchmark: boolean;
  checks_run: string[];
}

/** The deciding model's reasoning on one sample crop it found errors on. */
export interface ICropReasoning {
  verdict: "minor" | "major";
  /** one sentence for data users (prompt pq-v6 on); null before */
  summary: string | null;
  errors: string[];
}

/** The audit rows of the dataset page (public.get_dataset_audit_summary): the findings data users
 * judge a dataset by, with the deciding model's reasoning per prediction layer. */
export type IDatasetAuditSummary = { deadwood_reasoning?: ICropReasoning[]; forest_cover_reasoning?: ICropReasoning[] } & Pick<
  IAuditDatasetResult,
  | "review_required"
  | "evaluation_decision"
  | "georef_status"
  | "georef_offset_m"
  | "deadwood_total"
  | "deadwood_major"
  | "deadwood_minor"
  | "forest_cover_total"
  | "forest_cover_major"
  | "forest_cover_minor"
>;
