/** What the Audit Review page says about a dataset and what Save stores: each step's status from
 * audit.dataset_outcomes, the "Review required for …" line, and the reviewer's answers as dataset
 * reviews (docs/audit-checks.md). Checks report output values; only the dataset evaluation has a
 * decision (OK or Exclude). */

import type {
  AuditCheckKey,
  DatasetReviewInput,
  EvaluationDecision,
  GeorefStatus,
  IAuditDatasetResult,
  ITileCall,
  PredictionLayer,
  ReviewItem,
} from "../types/auditChecks";
import { auditSection, type AuditSectionId, type AuditTone } from "./auditChecks";

/** The review items in page order (audit.dataset_outcomes.review_required keeps the same order).
 * The prediction layers are never one: they are reviewed on a sample. */
export const REVIEW_ITEMS: ReviewItem[] = ["evaluation", "aoi", "georef", "date"];

export const REVIEW_ITEM_LABELS: Record<ReviewItem, string> = {
  evaluation: "Dataset evaluation",
  aoi: "Area of interest",
  georef: "Georeferencing",
  date: "Acquisition date",
};

export const DECISION_LABELS: Record<EvaluationDecision, string> = { keep: "OK", exclude: "Exclude" };
const DECISION_TONE: Record<EvaluationDecision, AuditTone> = { keep: "ok", exclude: "bad" };

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

/** A prediction layer's tile counts; ambiguous answers are not in the total. */
export interface ILayerCounts {
  total: number;
  major: number;
  minor: number;
  ok: number;
  ambiguous?: number;
}

/** A prediction layer's tile counts from the view. */
export function layerResult(result: IAuditDatasetResult | null | undefined, layer: PredictionLayer): ILayerCounts | null {
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
export function sectionStatus(id: AuditSectionId, result: IAuditDatasetResult | null | undefined, open: ReviewItem[], checksRun: AuditCheckKey[]): IAuditSectionStatus {
  const item = auditSection(id).reviewItem;
  if (item && open.includes(item)) return REVIEW;
  if (!result) return NOT_RUN;
  switch (id) {
    case "evaluation":
      if (result.evaluation_decision) return { label: DECISION_LABELS[result.evaluation_decision], tone: DECISION_TONE[result.evaluation_decision] };
      return checksRun.includes("dataset_evaluation") ? { label: "Undecided", tone: "warn" } : NOT_RUN;
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

/** The reviewer's dataset evaluation answer, on the review page or the benchmark labeler. */
export interface IEvaluationAnswer {
  decision?: EvaluationDecision | null;
  excludeReason?: string | null;
  cogIssue?: boolean;
  thumbnailIssue?: boolean;
}

/** The reviewer's answers on the page, held in the form until Save. */
export interface IReviewDraft extends IEvaluationAnswer {
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
    // the date advice changed after a reviewer's answer: the reviewer answers afresh
    dateReplace: result?.review_required.includes("date") ? null : (result?.date_replace ?? null),
    dateNote: "",
  };
}

/** How far the review of a prediction layer goes: the tiles the check called and the ones a person answered. */
export interface ILayerProgress {
  crops: number;
  answered: number;
  /** answered ambiguous: no one can reliably tell; not in the layer's counts */
  ambiguous: number;
}

export function layerProgress(calls: ITileCall[], layer: PredictionLayer): ILayerProgress | null {
  const own = calls.filter((c) => c.layer === layer);
  if (!own.length) return null;
  return {
    crops: own.length,
    answered: own.filter((c) => c.by_person).length,
    ambiguous: own.filter((c) => c.verdict === "ambiguous").length,
  };
}

export interface IReviewAnswers {
  reviews: DatasetReviewInput[];
  /** what keeps Save from storing them, e.g. an exclusion without its reason */
  problems: string[];
  /** the review items the answers settle */
  answered: ReviewItem[];
}

const text = (value: string | null | undefined) => value?.trim() || null;

/** The dataset evaluation review of an answer and what keeps it from being stored, or null
 * without a decision. Save stores it, and so does adding the dataset to the benchmark. */
export function evaluationReview(answer: IEvaluationAnswer, datasetId: number, note?: string | null): { review: DatasetReviewInput; problems: string[] } | null {
  const { decision } = answer;
  if (!decision) return null;
  const keep = decision === "keep";
  return {
    review: {
      dataset_id: datasetId,
      check_key: "dataset_evaluation",
      decision,
      exclude_reason: keep ? null : (answer.excludeReason ?? null),
      // both issues are outputs of their own, whatever the decision
      cog_issue: !!answer.cogIssue,
      thumbnail_issue: !!answer.thumbnailIssue,
      note: text(note),
    },
    problems: keep || answer.excludeReason ? [] : ["Pick why the dataset is excluded."],
  };
}

/** The reviews Save stores: only what the reviewer answered or changed. A step whose draft still
 * holds the view's value stores nothing, unless it is open for review. */
export function reviewAnswers(draft: IReviewDraft, datasetId: number, result: IAuditDatasetResult | null | undefined): IReviewAnswers {
  const start = initialDraft(result);
  const required = new Set(result?.review_required ?? []);
  const reviews: DatasetReviewInput[] = [];
  const problems: string[] = [];
  const answered: ReviewItem[] = [];

  const evaluation = evaluationReview(draft, datasetId, draft.evaluationNote);
  const flagsChanged = !!draft.cogIssue !== !!start.cogIssue || !!draft.thumbnailIssue !== !!start.thumbnailIssue;
  if (evaluation && (draft.decision !== start.decision || flagsChanged || required.has("evaluation"))) {
    problems.push(...evaluation.problems);
    reviews.push(evaluation.review);
    answered.push("evaluation");
  }

  if (draft.georefStatus && (draft.georefStatus !== start.georefStatus || required.has("georef"))) {
    reviews.push({ dataset_id: datasetId, check_key: "georef", georef_status: draft.georefStatus, note: text(draft.georefNote) });
    answered.push("georef");
  }

  if (typeof draft.dateReplace === "boolean" && (draft.dateReplace !== start.dateReplace || required.has("date"))) {
    if (draft.dateReplace !== result?.date_replace && !text(draft.dateNote)) problems.push("Say in the note why the date check is overridden.");
    reviews.push({ dataset_id: datasetId, check_key: "acquisition_date", date_replace: draft.dateReplace, note: text(draft.dateNote) });
    answered.push("date");
  }

  return { reviews, problems, answered };
}
