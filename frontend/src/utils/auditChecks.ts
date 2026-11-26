/** How the Audit Review page reads the automated checks: section order, what the map shows,
 * people's answers and the crops and images a run judged. What a check reports on a dataset and
 * what still needs a person come from audit.dataset_results (utils/auditReview.ts). */

import type {
  AuditCheckKey,
  AuditImageKind,
  AuditLayer,
  AuditVerdict,
  IAuditAssessment,
  IAuditCheckEvidence,
  IAuditCrop,
  IAuditImage,
  IAuditRun,
  ReviewItem,
} from "../types/auditChecks";

export type AuditSectionId = "evaluation" | "aoi" | "georef" | "date" | "phenology" | "forest" | "deadwood";
export type CropImageKind = Extract<AuditImageKind, "raw" | "deadwood_overlay" | "forest_cover_overlay">;

/** What the map shows while a section is open: the georeferencing matches, or the crops the check judged. */
export type IAuditSectionMap =
  | { kind: "georef" }
  | {
      kind: "crops";
      /** the stored images of a crop the reviewer can switch between */
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
  /** dataset-level layers a person answers */
  layers: AuditLayer[];
  map: IAuditSectionMap | null;
  /** the map layers the step needs: shown while its section is open, the others hidden */
  shows: ISectionLayers;
  /** reviewers also answer per crop and layer */
  cropAnswers?: boolean;
  /** the item of audit.dataset_results.review_required the section answers, if any */
  reviewItem: ReviewItem | null;
}

/** Why a dataset is excluded: the dataset evaluation's fixed reasons, "other" last. */
export const EXCLUDE_REASONS: IAuditReason[] = [
  { code: "blurry", label: "Blurry" },
  { code: "no_trees", label: "No trees" },
  { code: "artifacts", label: "Artifacts" },
  { code: "not_rgb", label: "Not RGB" },
  { code: "broken_ortho", label: "Broken ortho" },
  { code: "too_dark", label: "Too dark" },
  { code: "other", label: "Other" },
];

export const AUDIT_SECTIONS: IAuditSectionDef[] = [
  {
    id: "evaluation",
    title: "Dataset evaluation",
    checkKey: "dataset_evaluation",
    layers: ["image"],
    map: { kind: "crops", images: ["raw"] },
    shows: ORTHO_ONLY,
    reviewItem: "evaluation",
  },
  { id: "aoi", title: "Area of interest", checkKey: null, layers: [], map: null, shows: AOI_ONLY, reviewItem: "aoi" },
  {
    id: "georef",
    title: "Georeferencing",
    checkKey: "georef",
    layers: ["georef"],
    map: { kind: "georef" },
    shows: ORTHO_ONLY,
    reviewItem: "georef",
  },
  {
    id: "date",
    title: "Acquisition date",
    checkKey: "acquisition_date",
    layers: ["acquisition_date"],
    map: null,
    shows: ORTHO_ONLY,
    reviewItem: "date",
  },
  {
    id: "phenology",
    title: "Phenology",
    checkKey: null,
    layers: [],
    map: null,
    shows: ORTHO_ONLY,
    reviewItem: null,
  },
  // the prediction check, one layer after the other: each step shows only its own layer. Deadwood,
  // the hardest, comes last.
  ...(["forest_cover", "deadwood"] as const).map(
    (layer): IAuditSectionDef => ({
      id: layer === "deadwood" ? "deadwood" : "forest",
      title: layer === "deadwood" ? "Deadwood prediction" : "Tree cover prediction",
      checkKey: "prediction_quality",
      layers: [layer],
      map: {
        kind: "crops",
        images: [layer === "deadwood" ? "deadwood_overlay" : "forest_cover_overlay", "raw"],
        showModelView: true,
      },
      shows: { aoi: true, deadwood: layer === "deadwood", forestCover: layer === "forest_cover" },
      cropAnswers: true,
      // never reviewed per dataset: a sample is
      reviewItem: null,
    }),
  ),
];

export const auditSection = (id: AuditSectionId) => AUDIT_SECTIONS.find((s) => s.id === id)!;

/** The audit page section that shows a check. */
export function sectionOfCheck(checkKey: AuditCheckKey): AuditSectionId {
  return AUDIT_SECTIONS.find((s) => s.checkKey === checkKey)!.id;
}

export const LAYER_LABELS: Partial<Record<AuditLayer, string>> = {
  deadwood: "Deadwood",
  forest_cover: "Tree cover",
};

export type AuditTone = "ok" | "warn" | "bad" | "todo";

/** The dataset-level rows the call rests on: rule rows first, then each model. */
export function automatedRows(evidence: IAuditCheckEvidence | undefined, layer: AuditLayer): IAuditAssessment[] {
  return (evidence?.automated ?? [])
    .filter((a) => a.crop_id === null && a.layer === layer)
    .sort((a, b) => Number(b.assessor_kind === "rule") - Number(a.assessor_kind === "rule") || a.assessor.localeCompare(b.assessor));
}

interface ITarget {
  checkKey: AuditCheckKey;
  layer: AuditLayer;
  cropId?: number | null;
}

const onTarget = ({ checkKey, layer, cropId = null }: ITarget) => (a: IAuditAssessment) =>
  a.check_key === checkKey && a.layer === layer && a.crop_id === cropId;

/** The review's answer on a target: the latest reviewer answer given on the current run, whoever
 * gave it (an audit has one review; a later answer replaces an earlier one). */
export function reviewAnswer(people: IAuditAssessment[], runId: number | undefined, target: ITarget) {
  return people.filter((a) => onTarget(target)(a) && a.run_id === runId).reduce<IAuditAssessment | null>((latest, a) => (!latest || a.id > latest.id ? a : latest), null);
}

/** People's latest answers after new ones arrive: a newer row replaces the same person's earlier one on its target. */
export function mergeAnswers(people: IAuditAssessment[], added: IAuditAssessment[]): IAuditAssessment[] {
  const replaces = (a: IAuditAssessment, b: IAuditAssessment) =>
    a.assessor_user_id === b.assessor_user_id && onTarget({ checkKey: b.check_key, layer: b.layer, cropId: b.crop_id })(a);
  return [...people.filter((p) => !added.some((a) => replaces(p, a))), ...added];
}

export type EvaluationFlag = "cog_issue" | "thumbnail_issue" | "reprocess";

/** The issues a kept dataset can carry (the benchmark label's and the old rule rows' details.fix_flags). */
export const EVALUATION_FLAGS: { flag: EvaluationFlag; label: string; inText: string }[] = [
  { flag: "cog_issue", label: "COG issue", inText: "COG issue" },
  { flag: "thumbnail_issue", label: "Thumbnail issue", inText: "thumbnail issue" },
  { flag: "reprocess", label: "Needs reprocessing", inText: "needs reprocessing" },
];

/** The problems to fix a dataset evaluation row names (details.fix_flags): the check's rule row, or a reviewer's answer. */
export function evaluationFlags(row: Pick<IAuditAssessment, "details"> | null | undefined): EvaluationFlag[] {
  const named = Array.isArray(row?.details?.fix_flags) ? row.details.fix_flags : [];
  return EVALUATION_FLAGS.map((f) => f.flag).filter((flag) => named.includes(flag));
}

/** A dataset evaluation verdict that keeps the dataset: ok, or the minor ("keep, fix") of earlier answers. */
export const keepsDataset = (verdict: AuditVerdict | null | undefined) => verdict === "ok" || verdict === "minor";

/** A dataset evaluation answer in a few words, the check's or a person's: "OK", "OK (COG issue)", "Exclude (blurry)". */
export function evaluationAnswerText(row: Pick<IAuditAssessment, "verdict" | "details" | "reason_code">): string {
  if (row.verdict === "unsure") return "Unsure";
  if (!keepsDataset(row.verdict)) {
    const code = row.reason_code ?? (typeof row.details.reason === "string" ? row.details.reason : null);
    const reason = EXCLUDE_REASONS.find((r) => r.code === code)?.label.toLowerCase();
    return reason ? `Exclude (${reason})` : "Exclude";
  }
  const flags = evaluationFlags(row);
  const fixes = EVALUATION_FLAGS.filter((f) => flags.includes(f.flag)).map((f) => f.inText);
  return fixes.length ? `OK (${fixes.join(", ")})` : "OK";
}

/** The crop sets each check picks (audit.crops.crop_sets). */
const CHECK_CROP_SETS: Partial<Record<AuditCheckKey, string[]>> = {
  dataset_evaluation: ["evaluation"],
  prediction_quality: ["exclude", "training"],
};

/** What a run says it judged (runs.evidence.judged). Crops and images are stored per ortho and
 * shared by every run on it, so the run names its own crops, and the image files that differ
 * from the stored rows (a run with another AOI sees other parts darkened). */
interface IRunJudged {
  crop_ids?: number[];
  images?: { crop_id?: number | null; label_id?: number | null; kind: string; storage_path: string }[];
}

/** What one current run judged, picked from the dataset's rows of every check and run.
 * - Crops: the ones the run names. A run that names none (an earlier check version): those its
 *   rows name, and its own sets' crops of the ortho it judged.
 * - Images: of those crops and that ortho, with the run's own file where it differs. A crop
 *   keeps the overlays of earlier predictions, so overlays are limited to the predictions the
 *   run judged. */
export function runEvidence(
  run: IAuditRun,
  dataset: { automated: IAuditAssessment[]; crops: IAuditCrop[]; images: IAuditImage[] },
): IAuditCheckEvidence {
  const automated = dataset.automated.filter((a) => a.check_key === run.check_key);
  const ortho = run.inputs.ortho_sha256;
  const named = new Set(automated.map((a) => a.crop_id).filter((id): id is number => id !== null));
  const labels = new Set(automated.map((a) => a.label_id).filter((id): id is number => id !== null));
  const sets = CHECK_CROP_SETS[run.check_key] ?? [];
  const judged = (run.evidence?.judged ?? {}) as IRunJudged;
  const own = judged.crop_ids && new Set(judged.crop_ids);
  const crops = dataset.crops.filter((c) =>
    own ? own.has(c.id) : named.has(c.id) || (c.ortho_sha256 === ortho && c.crop_sets.some((set) => sets.includes(set))),
  );
  const cropIds = new Set(crops.map((c) => c.id));
  // an entry without a crop is the run's overview or thumbnail; the dataset evaluation names its crops by index only
  const imageKey = (i: { crop_id?: number | null; label_id?: number | null; kind: string }) => `${i.crop_id ?? null}:${i.label_id ?? null}:${i.kind}`;
  const ownFiles = new Map((judged.images ?? []).filter((i) => i.crop_id != null || i.kind !== "raw").map((i) => [imageKey(i), i.storage_path]));
  return {
    run,
    automated,
    crops,
    images: dataset.images
      .filter(
        (i) =>
          (i.crop_id === null ? i.ortho_sha256 === ortho : cropIds.has(i.crop_id)) &&
          (i.label_id === null || labels.size === 0 || labels.has(i.label_id)),
      )
      .map((i) => ({ ...i, storage_path: ownFiles.get(imageKey(i)) ?? i.storage_path })),
  };
}

const CROP_SET_ORDER = ["exclude", "evaluation", "training", "benchmark"];
const firstSet = (sets: string[]) => Math.min(...sets.map((s) => (CROP_SET_ORDER.indexOf(s) + 1 || 9)));

/** The crops a check judged, in the order the page numbers them: the exclude set first. */
export function orderedCrops(evidence: Pick<IAuditCheckEvidence, "crops"> | undefined): IAuditCheckEvidence["crops"] {
  return [...(evidence?.crops ?? [])].sort((a, b) => firstSet(a.crop_sets) - firstSet(b.crop_sets) || a.id - b.id);
}

/** The crop before or after the selected one, wrapping around; the first (or last) when none is selected. */
export function stepCrop(crops: { id: number }[], cropId: number | null, by: 1 | -1): number | null {
  if (!crops.length) return null;
  const index = crops.findIndex((c) => c.id === cropId);
  const from = index >= 0 ? index : by > 0 ? -1 : 0;
  return crops[(from + by + crops.length) % crops.length].id;
}
