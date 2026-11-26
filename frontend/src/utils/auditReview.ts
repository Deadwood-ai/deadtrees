/** What the Audit Review page says about a dataset and what Save stores: each step's status from
 * audit.dataset_results, the "Review required for …" line, and the reviewer's answers as person
 * rows (docs/audit-checks.md). Checks report output values; only the dataset evaluation has a
 * verdict (OK or Exclude). */

import type {
  AuditCheckKey,
  AuditVerdict,
  EvaluationDecision,
  GeorefStatus,
  IAuditAnswerInput,
  IAuditChecks,
  IAuditDatasetResult,
  ReviewItem,
} from "../types/auditChecks";
import { auditSection, type AuditSectionId, type AuditTone } from "./auditChecks";
import { layerReview } from "./cropAnswers";
import { cropCalls, type ILayerCounts } from "./cropCalls";

export type PredictionReviewLayer = "deadwood" | "forest_cover";

/** The review items in page order (audit.dataset_results.review_required keeps the same order).
 * The prediction layers are never one: they are reviewed on a sample. */
export const REVIEW_ITEMS: ReviewItem[] = ["evaluation", "aoi", "georef", "date"];

export const REVIEW_ITEM_LABELS: Record<ReviewItem, string> = {
  evaluation: "Dataset evaluation",
  aoi: "Area of interest",
  georef: "Georeferencing",
  date: "Acquisition date",
};

export const DECISION_LABELS: Record<EvaluationDecision, string> = { ok: "OK", exclude: "Exclude" };
const DECISION_VERDICT: Record<EvaluationDecision, AuditVerdict> = { ok: "ok", exclude: "major" };
const DECISION_TONE: Record<EvaluationDecision, AuditTone> = { ok: "ok", exclude: "bad" };

/** The decision an evaluation verdict stands for: major excludes, ok and the minor of earlier rules
 * ("keep, fix") keep; unsure (or none) decides nothing. */
export function decisionOfVerdict(verdict: AuditVerdict | null | undefined): EvaluationDecision | null {
  if (verdict === "major") return "exclude";
  return verdict === "ok" || verdict === "minor" ? "ok" : null;
}

export const SOURCE_LABELS: Record<string, string> = { reviewer: "a reviewer", legacy: "an earlier manual audit", check: "the check" };

/** Within this offset a reviewer calls the georeferencing passed. */
export const GEOREF_PASS_M = 15;

export const GEOREF_LABELS: Record<GeorefStatus, string> = {
  estimated: "Estimated",
  no_reference: "No reference",
  needs_review: "Needs review",
  passed: `Passed (≤ ${GEOREF_PASS_M} m)`,
  not_passed: `Not passed (> ${GEOREF_PASS_M} m)`,
};

const metres = (m: number) => `${m < 10 ? m.toFixed(1) : Math.round(m)} m`;

/** The georeferencing output in a few words: "8.2 m offset", "No reference", "Needs review (best reference 22 m)". */
export function georefText(result: Pick<IAuditDatasetResult, "georef_status" | "georef_offset_m"> | null | undefined): string {
  const status = result?.georef_status;
  if (!status) return "Not run yet";
  const offset = result?.georef_offset_m;
  if (status === "estimated") return offset == null ? "Estimated" : `${metres(offset)} offset`;
  if (status === "needs_review") return offset == null ? "Needs review" : `Needs review (best reference ${metres(offset)})`;
  return GEOREF_LABELS[status];
}

/** A share of crops as a whole percentage, or null without crops. */
export const share = (part: number | null | undefined, total: number | null | undefined) =>
  total ? Math.round(((part ?? 0) / total) * 100) : null;

/** A prediction layer's crop counts from the view. */
export function layerResult(result: IAuditDatasetResult | null | undefined, layer: PredictionReviewLayer) {
  if (!result) return null;
  const total = result[`${layer}_total`];
  if (total == null) return null;
  return { total, major: result[`${layer}_major`] ?? 0, minor: result[`${layer}_minor`] ?? 0, ok: result[`${layer}_ok`] ?? 0 };
}

/** The larger of the two layers' major crop shares (0 to 100), or null when neither ran. */
export function majorShare(result: IAuditDatasetResult): number | null {
  const shares = (["deadwood", "forest_cover"] as const)
    .map((layer) => layerResult(result, layer))
    .map((counts) => (counts ? share(counts.major, counts.total) : null))
    .filter((s): s is number => s !== null);
  return shares.length ? Math.max(...shares) : null;
}

/** The review items still open: the view's list without the ones answered on this page. */
export function openReviewItems(required: ReviewItem[] | null | undefined, answered: Iterable<ReviewItem>): ReviewItem[] {
  const done = new Set(answered);
  return REVIEW_ITEMS.filter((item) => (required ?? []).includes(item) && !done.has(item));
}

/** "Review required for Dataset evaluation, Georeferencing", or "No review required". */
export function reviewRequiredText(items: ReviewItem[]): string {
  return items.length ? `Review required for ${items.map((i) => REVIEW_ITEM_LABELS[i]).join(", ")}` : "No review required";
}

export interface IAuditSectionStatus {
  label: string;
  tone: AuditTone;
}

const REVIEW: IAuditSectionStatus = { label: "Review required", tone: "warn" };
const NOT_RUN: IAuditSectionStatus = { label: "Not run yet", tone: "todo" };

/** A step's badge: "Review required" while it is open for review, else the check's output. */
export function sectionStatus(id: AuditSectionId, result: IAuditDatasetResult | null | undefined, open: ReviewItem[]): IAuditSectionStatus {
  const item = auditSection(id).reviewItem;
  if (item && open.includes(item)) return REVIEW;
  if (!result) return NOT_RUN;
  switch (id) {
    case "evaluation":
      if (result.evaluation_decision) return { label: DECISION_LABELS[result.evaluation_decision], tone: DECISION_TONE[result.evaluation_decision] };
      return result.checks_run.includes("dataset_evaluation") ? { label: "Undecided", tone: "warn" } : NOT_RUN;
    case "aoi":
      return result.aoi_exists ? { label: "Set", tone: "ok" } : { label: "Missing", tone: "todo" };
    case "georef": {
      const status = result.georef_status;
      if (!status) return NOT_RUN;
      const tone: AuditTone =
        status === "not_passed"
          ? "bad"
          : status === "needs_review" || (status === "estimated" && (result.georef_offset_m ?? 0) > GEOREF_PASS_M)
            ? "warn"
            : status === "no_reference"
              ? "todo"
              : "ok";
      return { label: status === "estimated" ? georefText(result).replace(" offset", "") : GEOREF_LABELS[status].split(" (")[0], tone };
    }
    case "date":
      if (result.date_replace === null) return NOT_RUN;
      return result.date_replace ? { label: "Replace", tone: "warn" } : { label: "Keep reported", tone: "ok" };
    case "phenology": {
      const p = result.phenology_probability;
      return p == null ? { label: "No data", tone: "todo" } : { label: `${Math.round(p * 100)}%`, tone: p >= 0.5 ? "ok" : "warn" };
    }
    case "deadwood":
    case "forest": {
      const counts = layerResult(result, id === "deadwood" ? "deadwood" : "forest_cover");
      if (!counts) return NOT_RUN;
      return { label: `${counts.major} of ${counts.total} major`, tone: counts.major ? "warn" : "ok" };
    }
  }
}

/** The reviewer's answers on the page, held in the form until Save. */
export interface IReviewDraft {
  decision?: EvaluationDecision | null;
  excludeReason?: string | null;
  cogIssue?: boolean;
  thumbnailIssue?: boolean;
  evaluationNote?: string;
  georefStatus?: "passed" | "not_passed" | null;
  georefNote?: string;
  dateReplace?: boolean | null;
  dateNote?: string;
}

/** The view's row with your answers on the page in place of the outputs they replace. */
export function withDraft(result: IAuditDatasetResult, draft: IReviewDraft): IAuditDatasetResult {
  return {
    ...result,
    evaluation_decision: draft.decision ?? result.evaluation_decision,
    georef_status: draft.georefStatus ?? result.georef_status,
    date_replace: draft.dateReplace ?? result.date_replace,
  };
}

/** What the form starts with: the view's values, so a step left alone stores nothing. */
export function initialDraft(result: IAuditDatasetResult | null | undefined): IReviewDraft {
  const georef = result?.georef_source === "reviewer" ? result.georef_status : null;
  return {
    decision: result?.evaluation_decision ?? null,
    excludeReason: null,
    cogIssue: result?.cog_issue ?? false,
    thumbnailIssue: result?.thumbnail_issue ?? false,
    evaluationNote: "",
    georefStatus: georef === "passed" || georef === "not_passed" ? georef : null,
    georefNote: "",
    // AerialStamp dated it again after an override: the reviewer answers afresh
    dateReplace: result?.review_required.includes("date") ? null : (result?.date_replace ?? null),
    dateNote: "",
  };
}

/** A prediction layer as the reviewer left it on this page. Your crop answers are stored at once;
 * nothing of the layer waits for Save. */
export interface ILayerReview {
  /** the layer's counts with your crop answers in place of the check's calls */
  counts: ILayerCounts;
  /** the prediction the run judged */
  labelId: number | null;
  /** how far you are: the run's crops and the ones you answered */
  crops: number;
  answered: number;
}

export interface IReviewContext {
  datasetId: number;
  result: IAuditDatasetResult | null | undefined;
  /** the current run of each check that has one */
  runs: Partial<Record<AuditCheckKey, number>>;
  layers: Partial<Record<PredictionReviewLayer, ILayerReview>>;
}

export interface IReviewAnswers {
  answers: IAuditAnswerInput[];
  /** what keeps Save from storing them, e.g. an exclusion without its reason */
  problems: string[];
  /** the review items the answers settle */
  answered: ReviewItem[];
}

const text = (value: string | null | undefined) => value?.trim() || null;

/** The person row of the reviewer's evaluation decision and what keeps it from being stored, or
 * null without a decision. Save stores it, and so does adding the dataset to the benchmark. */
export function evaluationAnswer(draft: IReviewDraft, ctx: Pick<IReviewContext, "datasetId" | "runs">): { row: IAuditAnswerInput; problems: string[] } | null {
  const { decision } = draft;
  if (!decision) return null;
  return {
    row: {
      check_key: "dataset_evaluation",
      dataset_id: ctx.datasetId,
      run_id: ctx.runs.dataset_evaluation ?? null,
      layer: "image",
      verdict: DECISION_VERDICT[decision],
      reason_code: decision === "exclude" ? (draft.excludeReason ?? null) : null,
      reason_text: text(draft.evaluationNote),
      output: { cog_issue: !!draft.cogIssue, thumbnail_issue: !!draft.thumbnailIssue },
    },
    problems: decision === "exclude" && !draft.excludeReason ? ["Pick why the dataset is excluded."] : [],
  };
}

/** The person rows Save stores: only what the reviewer answered or changed. A step whose draft
 * still holds the view's value stores nothing, unless it is open for review. */
export function reviewAnswers(draft: IReviewDraft, ctx: IReviewContext): IReviewAnswers {
  const { datasetId, result, runs } = ctx;
  const start = initialDraft(result);
  const required = new Set(result?.review_required ?? []);
  const answers: IAuditAnswerInput[] = [];
  const problems: string[] = [];
  const answered: ReviewItem[] = [];
  const row = (checkKey: AuditCheckKey, layer: IAuditAnswerInput["layer"], fields: Partial<IAuditAnswerInput>): IAuditAnswerInput => ({
    check_key: checkKey,
    dataset_id: datasetId,
    run_id: runs[checkKey] ?? null,
    layer,
    verdict: null,
    ...fields,
  });

  const evaluation = evaluationAnswer(draft, ctx);
  const flagsChanged = !!draft.cogIssue !== !!start.cogIssue || !!draft.thumbnailIssue !== !!start.thumbnailIssue;
  if (evaluation && (draft.decision !== start.decision || flagsChanged || required.has("evaluation"))) {
    problems.push(...evaluation.problems);
    answers.push(evaluation.row);
    answered.push("evaluation");
  }

  if (draft.georefStatus && (draft.georefStatus !== start.georefStatus || required.has("georef"))) {
    answers.push(row("georef", "georef", { output: { status: draft.georefStatus }, reason_text: text(draft.georefNote) }));
    answered.push("georef");
  }

  if (typeof draft.dateReplace === "boolean" && (draft.dateReplace !== start.dateReplace || required.has("date"))) {
    if (draft.dateReplace !== result?.date_replace && !text(draft.dateNote)) problems.push("Say in the note why the date check is overridden.");
    answers.push(row("acquisition_date", "acquisition_date", { output: { replace: draft.dateReplace }, reason_text: text(draft.dateNote) }));
    answered.push("date");
  }

  return { answers, problems, answered };
}

/** What Save needs besides the draft (the current runs), and each prediction layer with the review's crop decisions. */
export function reviewContext(datasetId: number, result: IAuditDatasetResult | null | undefined, checks: IAuditChecks | undefined): IReviewContext {
  const runs: IReviewContext["runs"] = {};
  for (const [checkKey, evidence] of Object.entries(checks?.checks ?? {})) if (evidence) runs[checkKey as AuditCheckKey] = evidence.run.id;
  const layers: IReviewContext["layers"] = {};
  const prediction = checks?.checks.prediction_quality;
  if (prediction?.crops.length) {
    for (const layer of ["forest_cover", "deadwood"] as const) {
      layers[layer] = layerReview(prediction, cropCalls(prediction, [layer]), layer, checks?.people ?? []);
    }
  }
  return { datasetId, result, runs, layers };
}
