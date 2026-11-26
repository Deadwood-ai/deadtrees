/** Rows of the automated audit (audit schema, docs/audit-checks.md), with the columns the pages read.
 * Models' and people's answers are stored; every result is a view. */

/** not_assessable: a model's "can't assess" or a person's "can't tell what the tile shows";
 * ambiguous: a person's answer when no one can reliably tell (shrub or tree, an unusual dieback) */
export type AuditVerdict = "ok" | "minor" | "major" | "ambiguous" | "not_assessable";
export type AuditCheckKey = "dataset_evaluation" | "georef" | "acquisition_date" | "prediction_quality";
/** The checks a person answers about a whole dataset (audit.dataset_human_reviews.check_key). */
export type DatasetReviewCheck = "dataset_evaluation" | "georef" | "acquisition_date";
export type PredictionLayer = "deadwood" | "forest_cover";
/** The dataset evaluation's decision: a person's, the check's, and the one that counts
 * (audit.evaluation_decisions, and audit_decision on the public side). */
export type EvaluationDecision = "keep" | "exclude";

/** One row of audit.current_runs: the run that counts for a dataset and check. */
export interface ICurrentRun {
  dataset_id: number;
  check_key: AuditCheckKey;
  run_id: number;
}

/** One row of audit.tiles: a square of the ortho a run judged. */
export interface IAuditTile {
  id: number;
  dataset_id: number;
  geometry: GeoJSON.Polygon;
}

export type AuditImageKind = "raw" | "deadwood_overlay" | "forest_cover_overlay" | "overview" | "thumbnail";

/** One row of audit.images: a picture a run cut and judged. */
export interface IAuditImage {
  id: number;
  run_id: number;
  dataset_id: number;
  /** null for the dataset overview and thumbnail */
  tile_id: number | null;
  /** the prediction an overlay shows */
  prediction_label_id: number | null;
  kind: AuditImageKind;
  storage_path: string;
  width: number;
  height: number;
}

/** One model's answer about a whole dataset (audit.dataset_vlm_judgements). */
export interface IDatasetJudgement {
  id: number;
  run_id: number;
  dataset_id: number;
  judge: string;
  verdict: AuditVerdict;
  cog_issue: boolean | null;
  thumbnail_issue: boolean | null;
  exclude_reason: string | null;
  summary: string | null;
}

/** A model's score for one error type. */
export interface IProblemScore {
  likelihood?: number;
  area_pct?: number;
}

/** One model's answer about a tile and layer (audit.tile_vlm_judgements). */
export interface ITileJudgement {
  id: number;
  run_id: number;
  tile_id: number;
  layer: PredictionLayer;
  judge: string;
  verdict: AuditVerdict;
  problems: Record<string, IProblemScore> | null;
  summary: string | null;
}

/** A person's answer on an error type: seen (true) or not sure. */
export type ProblemTag = true | "unsure";

/** The call on a tile and layer of the current prediction check (audit.tile_calls): a person's
 * review of that prediction when there is one, else the deciding model's answer under the rules. */
export interface ITileCall {
  dataset_id: number;
  run_id: number;
  tile_id: number;
  layer: PredictionLayer;
  prediction_label_id: number | null;
  /** null when the deciding model could not assess the tile */
  verdict: AuditVerdict | null;
  by_person: boolean;
  /** the person's review the call rests on */
  review_id: number | null;
  /** the deciding judge's answer under the rules (tile_vlm_judgements), null without one */
  judgement_id: number | null;
}

/** A person's answer about a whole dataset on one check (audit.dataset_human_reviews, and the
 * newest per check in audit.current_dataset_human_reviews). */
export interface IDatasetReview {
  id: number;
  dataset_id: number;
  check_key: DatasetReviewCheck;
  decision: EvaluationDecision | null;
  exclude_reason: string | null;
  cog_issue: boolean | null;
  thumbnail_issue: boolean | null;
  georef_status: "passed" | "not_passed" | null;
  date_replace: boolean | null;
  note: string | null;
  in_benchmark: boolean;
  reviewed_by: string | null;
  created_at: string;
  /** the ortho (or the date advice) changed since: it no longer counts */
  stale?: boolean;
  /** the reviewer's email, added by the page for auditors */
  reviewer_email?: string | null;
}

/** A person's answer about a tile and layer (audit.tile_human_reviews). */
export interface ITileReview {
  id: number;
  dataset_id: number;
  tile_id: number;
  layer: PredictionLayer;
  /** the prediction the person judged */
  prediction_label_id: number | null;
  verdict: AuditVerdict;
  problems: Record<string, ProblemTag> | null;
  note: string | null;
  in_benchmark: boolean;
  reviewed_by: string | null;
  created_at: string;
  reviewer_email?: string | null;
}

/** What a page inserts: the database fills id, reviewed_by, created_at and the evidence key. */
export type DatasetReviewInput = Pick<IDatasetReview, "dataset_id" | "check_key"> &
  Partial<Pick<IDatasetReview, "decision" | "exclude_reason" | "cog_issue" | "thumbnail_issue" | "georef_status" | "date_replace" | "note" | "in_benchmark">>;
export type TileReviewInput = Pick<ITileReview, "dataset_id" | "tile_id" | "layer" | "prediction_label_id" | "verdict" | "problems"> &
  Partial<Pick<ITileReview, "note" | "in_benchmark">>;

/** What one check's current run judged on a dataset: its tiles and images. */
export interface IAuditCheckEvidence {
  run: ICurrentRun;
  /** in the order the page numbers them */
  tiles: IAuditTile[];
  images: IAuditImage[];
}

/** The dataset's automated checks: what each current run judged and what the models said. */
export interface IAuditChecks {
  /** false while the audit schema cannot be read (not exposed on this server) */
  available: boolean;
  checks: Partial<Record<AuditCheckKey, IAuditCheckEvidence>>;
  /** each model's answer of the current dataset evaluation run */
  datasetJudgements: IDatasetJudgement[];
  /** the answer the evaluation's call rests on (audit.evaluation_calls.judgement_id); null for
   * a recorded call, an empty COG or a band exclusion */
  evaluationJudgementId: number | null;
  /** each model's answer per tile and layer of the current prediction quality run */
  tileJudgements: ITileJudgement[];
}

/** People's answers on a dataset as they count now, and the tile calls they change. */
export interface IAuditReviews {
  /** the newest review per check (stale ones marked) */
  datasetReviews: IDatasetReview[];
  tileCalls: ITileCall[];
  /** the reviews the tile calls rest on */
  tileReviews: ITileReview[];
}

/** What a person still has to look at on a dataset (audit.dataset_outcomes.review_required), in page order. */
export type ReviewItem = "evaluation" | "aoi" | "georef" | "date";
export type GeorefStatus = "estimated" | "no_reference" | "needs_review" | "passed" | "not_passed";

/** One row of audit.dataset_outcomes: every dataset with each check's output (a person's
 * correction included), whether a person still has to review it and where the values come from. */
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
  in_benchmark: boolean;
}

/** The deciding model's reasoning on one sample tile it found errors on. */
export interface ICropReasoning {
  verdict: "minor" | "major";
  /** one sentence for data users (prompt pq-v6 on); null before */
  summary: string | null;
  errors: string[];
}

/** The audit rows of the dataset page (public.get_dataset_audit_summary): the findings data users
 * judge a dataset by, the deciding model's reasoning per prediction layer, and the suggested
 * date (a reviewer's correction included). */
export type IDatasetAuditSummary = { deadwood_reasoning?: ICropReasoning[]; forest_cover_reasoning?: ICropReasoning[] } & Pick<
  IAuditDatasetResult,
  | "review_required"
  | "evaluation_decision"
  | "georef_status"
  | "georef_offset_m"
  | "date_replace"
  | "date_new"
  | "deadwood_total"
  | "deadwood_major"
  | "deadwood_minor"
  | "forest_cover_total"
  | "forest_cover_major"
  | "forest_cover_minor"
>;
