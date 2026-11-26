/** How the Audit Review page reads the automated checks: section order, what the map shows and
 * the dataset evaluation's answers in words. What a check reports on a dataset and what still
 * needs a person come from audit.dataset_outcomes (utils/auditReview.ts). */

import type { AuditCheckKey, AuditImageKind, AuditVerdict, IDatasetJudgement, IDatasetReview, PredictionLayer, ReviewItem } from "../types/auditChecks";

export type AuditSectionId = "evaluation" | "aoi" | "georef" | "date" | "phenology" | "forest" | "deadwood";
export type CropImageKind = Extract<AuditImageKind, "raw" | "deadwood_overlay" | "forest_cover_overlay">;

/** What the map shows while a section is open: the georeferencing matches, or the tiles the check judged. */
export type IAuditSectionMap =
  | { kind: "georef" }
  | {
      kind: "crops";
      /** the stored images of a tile the reviewer can switch between */
      images: CropImageKind[];
      /** the step opens with "what the model saw" shown (the first of `images`) */
      showModelView?: boolean;
    };

/** Map layers a step switches on (true) or off (false) while its section is open. */
export interface ISectionLayers {
  aoi: boolean;
  deadwood: boolean;
  forestCover: boolean;
}

const ORTHO_ONLY: ISectionLayers = { aoi: false, deadwood: false, forestCover: false };
// the predictions stay off outside their own steps, so the image is judged as it is
const AOI_ONLY: ISectionLayers = { aoi: true, deadwood: false, forestCover: false };

export interface IAuditReason {
  code: string;
  label: string;
}

export interface IAuditSectionDef {
  id: AuditSectionId;
  title: string;
  checkKey: AuditCheckKey | null;
  /** the prediction layer reviewers answer per tile (the prediction steps) */
  layer: PredictionLayer | null;
  map: IAuditSectionMap | null;
  /** the map layers the step needs: shown while its section is open, the others hidden */
  shows: ISectionLayers;
  /** the item of audit.dataset_outcomes.review_required the section answers, if any */
  reviewItem: ReviewItem | null;
}

/** Why a dataset is excluded: the dataset evaluation's fixed reasons, "other" last. `inText` is
 * the reason mid-sentence, plain enough for the dataset's owner. */
export const EXCLUDE_REASONS: (IAuditReason & { inText: string })[] = [
  { code: "blurry", label: "Blurry", inText: "blurry" },
  { code: "no_trees", label: "No trees", inText: "no trees" },
  { code: "artifacts", label: "Artifacts", inText: "artifacts" },
  { code: "not_rgb", label: "Not RGB", inText: "not true colour" },
  { code: "broken_ortho", label: "Broken ortho", inText: "broken or incomplete image" },
  { code: "too_dark", label: "Too dark", inText: "too dark" },
  { code: "other", label: "Other", inText: "other reason" },
];

export const AUDIT_SECTIONS: IAuditSectionDef[] = [
  {
    id: "evaluation",
    title: "Dataset evaluation",
    checkKey: "dataset_evaluation",
    layer: null,
    map: { kind: "crops", images: ["raw"] },
    shows: ORTHO_ONLY,
    reviewItem: "evaluation",
  },
  { id: "aoi", title: "Area of interest", checkKey: null, layer: null, map: null, shows: AOI_ONLY, reviewItem: "aoi" },
  { id: "georef", title: "Georeferencing", checkKey: "georef", layer: null, map: { kind: "georef" }, shows: ORTHO_ONLY, reviewItem: "georef" },
  { id: "date", title: "Acquisition date", checkKey: "acquisition_date", layer: null, map: null, shows: ORTHO_ONLY, reviewItem: "date" },
  { id: "phenology", title: "Phenology", checkKey: null, layer: null, map: null, shows: ORTHO_ONLY, reviewItem: null },
  // the prediction check, one layer after the other: each step shows only its own layer. Deadwood,
  // the hardest, comes last.
  ...(["forest_cover", "deadwood"] as const).map(
    (layer): IAuditSectionDef => ({
      id: layer === "deadwood" ? "deadwood" : "forest",
      title: layer === "deadwood" ? "Deadwood prediction" : "Tree cover prediction",
      checkKey: "prediction_quality",
      layer,
      map: {
        kind: "crops",
        images: [layer === "deadwood" ? "deadwood_overlay" : "forest_cover_overlay", "raw"],
        showModelView: true,
      },
      shows: { aoi: true, deadwood: layer === "deadwood", forestCover: layer === "forest_cover" },
      // never reviewed per dataset: a sample is
      reviewItem: null,
    }),
  ),
];

export const auditSection = (id: AuditSectionId) => AUDIT_SECTIONS.find((s) => s.id === id)!;

export const LAYER_LABELS: Record<PredictionLayer, string> = {
  deadwood: "Deadwood",
  forest_cover: "Tree cover",
};

export type AuditTone = "ok" | "warn" | "bad" | "todo";

/** A verdict in a word. */
export const VERDICT_WORD: Record<AuditVerdict, string> = { ok: "OK", minor: "Minor", major: "Major", ambiguous: "Ambiguous", not_assessable: "Can't tell" };

export type EvaluationFlag = "cog_issue" | "thumbnail_issue";

/** The issues a kept dataset can carry. */
export const EVALUATION_FLAGS: { flag: EvaluationFlag; label: string; inText: string }[] = [
  { flag: "cog_issue", label: "COG issue", inText: "COG issue" },
  { flag: "thumbnail_issue", label: "Thumbnail issue", inText: "thumbnail issue" },
];

/** An exclusion reason code mid-sentence ("blurry"), undefined for none or an unknown code. */
export const reasonWord = (code: string | null | undefined) => EXCLUDE_REASONS.find((r) => r.code === code)?.inText;

/** A person's dataset evaluation answer in a few words: "OK", "OK (COG issue)", "Exclude (blurry)". */
export function evaluationAnswerText(review: Pick<IDatasetReview, "decision" | "exclude_reason" | "cog_issue" | "thumbnail_issue">): string {
  if (review.decision === "exclude") {
    const reason = reasonWord(review.exclude_reason);
    return reason ? `Exclude (${reason})` : "Exclude";
  }
  if (review.decision !== "keep") return "Undecided";
  const fixes = EVALUATION_FLAGS.filter((f) => review[f.flag]).map((f) => f.inText);
  return fixes.length ? `OK (${fixes.join(", ")})` : "OK";
}

/** A model's dataset evaluation answer in a few words: its verdict, the reason it excludes for, the issues it saw. */
export function judgementText(judgement: Pick<IDatasetJudgement, "verdict" | "exclude_reason" | "cog_issue" | "thumbnail_issue">): string {
  const reason = judgement.verdict === "major" ? reasonWord(judgement.exclude_reason) : null;
  const issues = EVALUATION_FLAGS.filter((f) => judgement[f.flag]).map((f) => f.inText);
  const extra = [reason, ...issues].filter(Boolean);
  return `${VERDICT_WORD[judgement.verdict]}${extra.length ? ` (${extra.join(", ")})` : ""}`;
}

/** A judge's short name: "luna-medium" → "Luna", "haiku-5.5" → "Haiku". */
export const judgeName = (judge: string | null) => (judge ? judge.split("-")[0].replace(/^\w/, (c) => c.toUpperCase()) : "Model");

/** The tile before or after the selected one, wrapping around; the first (or last) when none is selected. */
export function stepCrop(crops: { id: number }[], cropId: number | null, by: 1 | -1): number | null {
  if (!crops.length) return null;
  const index = crops.findIndex((c) => c.id === cropId);
  const from = index >= 0 ? index : by > 0 ? -1 : 0;
  return crops[(from + by + crops.length) % crops.length].id;
}
