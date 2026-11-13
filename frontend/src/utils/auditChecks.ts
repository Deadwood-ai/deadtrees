/** How the audit page reads the automated checks: section order, what the map shows,
 * verdict labels, status, the answer a reviewer gives and the decision derived from the sections. */

import type { AuditFormValues, DatasetDisposition, PredictionQuality } from "../hooks/useDatasetAudit";
import type { IAcquisitionDateEstimate, IAuditReviewItem } from "../types/acquisitionDate";
import type {
  AuditCheckKey,
  AuditImageKind,
  AuditLayer,
  AuditVerdict,
  IAuditAssessment,
  IAuditCheckEvidence,
  IAuditChecks,
  IAuditCrop,
  IAuditImage,
  IAuditQueueRow,
  IAuditRun,
} from "../types/auditChecks";
import type { IGeorefCheck } from "../types/georefCheck";
import { reportedOutsideLikelyRange } from "./acquisitionDate";
import { summarizeGeorefCheck } from "./georefCheck";

export type AuditSectionId = "evaluation" | "aoi" | "georef" | "date" | "phenology" | "forest" | "deadwood";
export type CropImageKind = Extract<AuditImageKind, "raw" | "deadwood_overlay" | "forest_cover_overlay">;

/** What the map shows while a section is open: the georeferencing matches, or the crops the check judged. */
export type IAuditSectionMap =
  | { kind: "georef" }
  | {
      kind: "crops";
      /** the stored images of a crop the reviewer can switch between */
      images: CropImageKind[];
      /** layers whose model verdict can colour the squares */
      colorLayers: AuditLayer[];
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
const ALL_LAYERS: ISectionLayers = { aoi: true, deadwood: true, forestCover: true };

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
  /** the fixed "Check wrong" reasons; "other" always comes last */
  reasons: IAuditReason[];
  /** the verdicts a reviewer can give. Two: "Check wrong" flips the call. Three: the reviewer picks. */
  verdicts: AuditVerdict[];
  /** the saved-audit fields the section holds; a failed save opens the section of the first one missing */
  fields: (keyof AuditFormValues)[];
}

const OTHER: IAuditReason = { code: "other", label: "Other" };

export const AUDIT_SECTIONS: IAuditSectionDef[] = [
  {
    id: "evaluation",
    title: "Dataset evaluation",
    checkKey: "dataset_evaluation",
    layers: ["image"],
    map: { kind: "crops", images: ["raw"], colorLayers: [] },
    shows: ORTHO_ONLY,
    // why a dataset is excluded: the reviewer answers Keep or Exclude, not "check wrong"
    reasons: [
      { code: "blurry", label: "Blurry" },
      { code: "no_trees", label: "No trees" },
      { code: "artifacts", label: "Artifacts" },
      { code: "not_rgb", label: "Not RGB" },
      { code: "broken_ortho", label: "Broken ortho" },
      { code: "too_dark", label: "Too dark" },
      OTHER,
    ],
    verdicts: ["ok", "minor", "major"],
    fields: ["has_cog_issue", "has_thumbnail_issue"],
  },
  { id: "aoi", title: "Area of interest", checkKey: null, layers: [], map: null, shows: ALL_LAYERS, reasons: [], verdicts: [], fields: [] },
  {
    id: "georef",
    title: "Georeferencing",
    checkKey: "georef",
    layers: ["georef"],
    map: { kind: "georef" },
    shows: ORTHO_ONLY,
    reasons: [
      { code: "offset_misjudged", label: "Offset misjudged" },
      { code: "reference_wrong_or_outdated", label: "Reference wrong or outdated" },
      { code: "no_real_match", label: "No real match" },
      OTHER,
    ],
    verdicts: ["ok", "major"],
    fields: ["is_georeferenced"],
  },
  {
    id: "date",
    title: "Acquisition date",
    checkKey: "acquisition_date",
    layers: ["acquisition_date"],
    map: null,
    shows: ORTHO_ONLY,
    reasons: [
      { code: "estimate_wrong", label: "Estimate wrong" },
      { code: "reported_date_right", label: "Reported date is right" },
      OTHER,
    ],
    verdicts: ["ok", "major"],
    fields: ["has_valid_acquisition_date", "accept_suggested_acquisition_date"],
  },
  {
    id: "phenology",
    title: "Phenology",
    checkKey: null,
    layers: [],
    map: null,
    shows: ORTHO_ONLY,
    reasons: [],
    verdicts: [],
    fields: ["has_valid_phenology"],
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
        colorLayers: [layer],
        showModelView: true,
      },
      shows: { aoi: true, deadwood: layer === "deadwood", forestCover: layer === "forest_cover" },
      cropAnswers: true,
      reasons: [
        { code: "errors_missed", label: "Model missed errors" },
        { code: "fine_prediction_flagged", label: "Model flagged a fine prediction" },
        { code: "crops_not_representative", label: "Crops not representative" },
        OTHER,
      ],
      verdicts: ["ok", "minor", "major"],
      fields: [layer === "deadwood" ? "deadwood_quality" : "forest_cover_quality"],
    }),
  ),
];

export const auditSection = (id: AuditSectionId) => AUDIT_SECTIONS.find((s) => s.id === id)!;

/** The section that holds a saved-audit field, if any (the final assessment sits above the sections). */
export const sectionOfField = (field: string): AuditSectionId | null =>
  AUDIT_SECTIONS.find((s) => (s.fields as string[]).includes(field))?.id ?? null;

/** The audit page section that shows a check. */
export function sectionOfCheck(checkKey: AuditCheckKey): AuditSectionId {
  return AUDIT_SECTIONS.find((s) => s.checkKey === checkKey)!.id;
}

const VERDICT_LABELS: Record<AuditCheckKey, Record<AuditVerdict, string>> = {
  dataset_evaluation: { ok: "Keep", minor: "Keep, fix", major: "Exclude", unsure: "Unsure" },
  georef: { ok: "Good", minor: "Small offset", major: "Poor", unsure: "Uncertain" },
  acquisition_date: { ok: "Valid", minor: "Close", major: "Mismatch", unsure: "Uncertain" },
  prediction_quality: { ok: "OK", minor: "Minor errors", major: "Major errors", unsure: "Unsure" },
};

export const LAYER_LABELS: Partial<Record<AuditLayer, string>> = {
  deadwood: "Deadwood",
  forest_cover: "Tree cover",
};

export function verdictLabel(checkKey: AuditCheckKey, verdict: AuditVerdict): string {
  return VERDICT_LABELS[checkKey][verdict];
}

/** Why a result goes to a person (audit.review_queue.reason): a short label and a clause after "Here because". */
export const QUEUE_REASONS: Record<NonNullable<IAuditQueueRow["reason"]>, { label: string; because: string }> = {
  review_all: { label: "Review all: new check", because: "every result of this check goes to a person for now" },
  unsure: { label: "Check unsure", because: "the check is unsure" },
  models_disagree: { label: "Models disagree", because: "the models disagree" },
  spot_check: { label: "Spot check", because: "it was picked as a spot check" },
};

export type AuditTone = "ok" | "warn" | "bad" | "todo";

export const VERDICT_TONE: Record<AuditVerdict, AuditTone> = { ok: "ok", minor: "warn", major: "bad", unsure: "warn" };

const SEVERITY: AuditVerdict[] = ["ok", "minor", "unsure", "major"];
const worst = (verdicts: AuditVerdict[]) =>
  verdicts.reduce<AuditVerdict | null>((w, v) => (w === null || SEVERITY.indexOf(v) > SEVERITY.indexOf(w) ? v : w), null);

/** The check's dataset-level call on a layer, as audit.review_queue derives it from the current run. */
export function automatedVerdict(evidence: IAuditCheckEvidence | undefined, layer: AuditLayer): AuditVerdict | null {
  return evidence?.queue.find((q) => q.layer === layer)?.verdict ?? null;
}

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

/** The signed-in reviewer's latest answer on a target, given on the current run. */
export function myAnswer(people: IAuditAssessment[], userId: string | undefined, runId: number | undefined, target: ITarget) {
  return people.find((a) => onTarget(target)(a) && a.assessor_user_id === userId && a.run_id === runId) ?? null;
}

/** Other reviewers' latest answers on a target and the current run. */
export function othersAnswers(people: IAuditAssessment[], userId: string | undefined, runId: number | undefined, target: ITarget) {
  return people.filter((a) => onTarget(target)(a) && a.assessor_user_id !== userId && a.run_id === runId);
}

/** People's latest answers after new ones arrive: a newer row replaces the same person's earlier one on its target. */
export function mergeAnswers(people: IAuditAssessment[], added: IAuditAssessment[]): IAuditAssessment[] {
  const replaces = (a: IAuditAssessment, b: IAuditAssessment) =>
    a.assessor_user_id === b.assessor_user_id && onTarget({ checkKey: b.check_key, layer: b.layer, cropId: b.crop_id })(a);
  return [...people.filter((p) => !added.some((a) => replaces(p, a))), ...added];
}

export interface IAuditSectionStatus {
  label: string;
  tone: AuditTone;
  needsYou: boolean;
}

const NOT_RUN: IAuditSectionStatus = { label: "Not run yet", tone: "todo", needsYou: false };

/** The badge of a section whose check has run: needs you, answered, or the call itself. */
export function sectionStatus(section: IAuditSectionDef, evidence: IAuditCheckEvidence, answered: boolean): IAuditSectionStatus {
  const verdict = worst(section.layers.map((l) => automatedVerdict(evidence, l)).filter((v): v is AuditVerdict => v !== null));
  // each reviewer answers on their own: a result under review needs you until you answered, whoever else did
  const underReview = evidence.queue.some((q) => q.reason !== null && section.layers.includes(q.layer));
  if (underReview && !answered) return { label: "Needs you", tone: verdict === "major" ? "bad" : "warn", needsYou: true };
  if (answered) return { label: "Answered", tone: "ok", needsYou: false };
  if (!verdict) return { label: "No call", tone: "todo", needsYou: false };
  return { label: verdictLabel(section.checkKey!, verdict), tone: VERDICT_TONE[verdict], needsYou: false };
}

export interface ILegacySectionInputs {
  hasAOI: boolean;
  phenology: boolean | null | undefined;
  georefCheck: IGeorefCheck | null | undefined;
  dateEstimate: IAcquisitionDateEstimate | null | undefined;
  /** saved audit items newer evidence disagrees with (public.audit_review_queue) */
  reviewItems: IAuditReviewItem[];
}

const GEOREF_TONES = { success: "ok", error: "bad", warning: "warn" } as const;

/** The badge of a section without a run in the audit tables: from the saved audit and the older check tables. */
export function legacySectionStatus(id: AuditSectionId, inputs: ILegacySectionInputs): IAuditSectionStatus {
  const underReview = (item: string) => inputs.reviewItems.some((i) => i.item === item);
  const needsYou: IAuditSectionStatus = { label: "Needs you", tone: "warn", needsYou: true };
  switch (id) {
    case "aoi":
      return inputs.hasAOI ? { label: "Set", tone: "ok", needsYou: false } : { label: "Missing", tone: "warn", needsYou: false };
    case "phenology":
      if (inputs.phenology === undefined || inputs.phenology === null) return { label: "Manual", tone: "todo", needsYou: false };
      return inputs.phenology ? { label: "In season", tone: "ok", needsYou: false } : { label: "Out of season", tone: "warn", needsYou: false };
    case "georef": {
      if (!inputs.georefCheck) return NOT_RUN;
      if (underReview("is_georeferenced")) return needsYou;
      const summary = summarizeGeorefCheck(inputs.georefCheck);
      return { label: summary.verdict.split(",")[0], tone: GEOREF_TONES[summary.tone], needsYou: false };
    }
    case "date":
      // no estimate: the reviewer judges the date by hand
      if (!inputs.dateEstimate) return { label: "Manual", tone: "todo", needsYou: false };
      if (underReview("acquisition_date")) return needsYou;
      if (inputs.dateEstimate.is_mismatch) return { label: "Mismatch", tone: "bad", needsYou: false };
      return reportedOutsideLikelyRange(inputs.dateEstimate) ? { label: "Uncertain", tone: "warn", needsYou: true } : { label: "Valid", tone: "ok", needsYou: false };
    default:
      return NOT_RUN;
  }
}

const VERDICT_QUALITY: Partial<Record<AuditVerdict, PredictionQuality>> = { ok: "great", minor: "sentinel_ok", major: "bad" };
const QUALITY_FIELD: Partial<Record<AuditLayer, "deadwood_quality" | "forest_cover_quality">> = {
  deadwood: "deadwood_quality",
  forest_cover: "forest_cover_quality",
};

/** The saved-audit field an answer decides. The dataset evaluation decides none: its COG and
 * thumbnail fields stay the reviewer's own, and its verdict feeds the derived decision. */
export function formValuesForVerdict(checkKey: AuditCheckKey, layer: AuditLayer, verdict: AuditVerdict): Partial<AuditFormValues> {
  if (verdict === "unsure") return {};
  switch (checkKey) {
    case "georef":
      return { is_georeferenced: verdict !== "major" };
    case "acquisition_date":
      return { has_valid_acquisition_date: verdict !== "major" };
    case "prediction_quality": {
      const field = QUALITY_FIELD[layer];
      return field ? { [field]: VERDICT_QUALITY[verdict] } : {};
    }
    case "dataset_evaluation":
      return {};
  }
}

export type EvaluationFlag = "cog_issue" | "thumbnail_issue" | "reprocess";

/** The problems a kept dataset can carry (the check's fix flags). Two of them are fields of the
 * saved audit, with a note each; reprocessing only makes the answer "keep, fix". */
export const EVALUATION_FLAGS: {
  flag: EvaluationFlag;
  label: string;
  inText: string;
  field?: "has_cog_issue" | "has_thumbnail_issue";
  notes?: "cog_issue_notes" | "thumbnail_issue_notes";
}[] = [
  { flag: "cog_issue", label: "COG issue", inText: "COG issue", field: "has_cog_issue", notes: "cog_issue_notes" },
  { flag: "thumbnail_issue", label: "Thumbnail issue", inText: "thumbnail issue", field: "has_thumbnail_issue", notes: "thumbnail_issue_notes" },
  { flag: "reprocess", label: "Needs reprocessing", inText: "needs reprocessing" },
];

/** The problems to fix a dataset evaluation row names (details.fix_flags): the check's rule row, or a reviewer's answer. */
export function evaluationFlags(row: Pick<IAuditAssessment, "details"> | null | undefined): EvaluationFlag[] {
  const named = Array.isArray(row?.details?.fix_flags) ? row.details.fix_flags : [];
  return EVALUATION_FLAGS.map((f) => f.flag).filter((flag) => named.includes(flag));
}

/** A dataset evaluation verdict that keeps the dataset (ok, or keep with something to fix). */
export const keepsDataset = (verdict: AuditVerdict | null | undefined) => verdict === "ok" || verdict === "minor";

/** A dataset evaluation answer in a few words, the check's or a person's: "Keep", "Keep (COG issue)", "Exclude (blurry)". */
export function evaluationAnswerText(row: Pick<IAuditAssessment, "verdict" | "details" | "reason_code">): string {
  if (row.verdict === "unsure") return "Unsure";
  if (!keepsDataset(row.verdict)) {
    const code = row.reason_code ?? (typeof row.details.reason === "string" ? row.details.reason : null);
    const reason = auditSection("evaluation").reasons.find((r) => r.code === code)?.label.toLowerCase();
    return reason ? `Exclude (${reason})` : "Exclude";
  }
  const flags = evaluationFlags(row);
  const fixes = EVALUATION_FLAGS.filter((f) => flags.includes(f.flag)).map((f) => f.inText);
  return fixes.length ? `Keep (${fixes.join(", ")})` : row.verdict === "minor" ? "Keep (something to fix)" : "Keep";
}

/** The saved-audit fields the reviewer's own answers on the current runs decide. */
export function answeredFormValues(checks: IAuditChecks | undefined, userId: string | undefined): Partial<AuditFormValues> {
  if (!checks || !userId) return {};
  return AUDIT_SECTIONS.reduce<Partial<AuditFormValues>>((values, section) => {
    const evidence = section.checkKey ? checks.checks[section.checkKey] : undefined;
    if (!evidence) return values;
    for (const layer of section.layers) {
      const mine = myAnswer(checks.people, userId, evidence.run.id, { checkKey: section.checkKey!, layer });
      if (!mine) continue;
      Object.assign(values, formValuesForVerdict(section.checkKey!, layer, mine.verdict));
      // The answer carries the reviewer's flags: none means the COG and the thumbnail are fine. An
      // answer from before the flags existed says nothing about them, so the saved audit keeps its values.
      if (section.checkKey === "dataset_evaluation" && Array.isArray(mine.details.fix_flags)) {
        const flags = evaluationFlags(mine);
        for (const { flag, field } of EVALUATION_FLAGS) if (field) values[field] = flags.includes(flag);
      }
    }
    return values;
  }, {});
}

export const DISPOSITION_LABELS: Record<DatasetDisposition, string> = {
  no_issues: "Ready",
  fixable_issues: "Fix",
  exclude_completely: "Exclude",
};

export interface IDerivedDecision {
  disposition: DatasetDisposition | null;
  /** what the decision rests on, e.g. "georeferencing poor" */
  because: string[];
  /** sections still without an answer */
  open: string[];
}

/** The final assessment the sections add up to. The dataset evaluation excludes; any
 * fixable finding makes it "Fix"; "Ready" needs every section answered. Phenology is
 * shown but does not decide (Clemens's check will). */
export function deriveDecision(values: Partial<AuditFormValues>, evaluation: AuditVerdict | null): IDerivedDecision {
  if (evaluation === "major") return { disposition: "exclude_completely", because: ["dataset evaluation: exclude"], open: [] };
  const fixes: [boolean, string][] = [
    // a "keep, fix" the two flags do not already name (the check may ask for reprocessing)
    [evaluation === "minor" && !values.has_cog_issue && !values.has_thumbnail_issue, "dataset evaluation: keep, fix"],
    [values.has_cog_issue === true, "COG issue"],
    [values.has_thumbnail_issue === true, "thumbnail issue"],
    [values.is_georeferenced === false, "georeferencing poor"],
    [values.has_valid_acquisition_date === false, "acquisition date wrong"],
    [values.deadwood_quality === "bad", "deadwood prediction bad"],
    [values.forest_cover_quality === "bad", "tree cover prediction bad"],
  ];
  const because = fixes.filter(([hit]) => hit).map(([, why]) => why);
  const missing: [unknown, string][] = [
    [values.has_cog_issue, "COG"],
    [values.has_thumbnail_issue, "thumbnail"],
    [values.is_georeferenced, "georeferencing"],
    [values.has_valid_acquisition_date, "acquisition date"],
    [values.has_valid_phenology, "phenology"],
    [values.deadwood_quality, "deadwood prediction"],
  ];
  const open = missing.filter(([value]) => value === undefined || value === null).map(([, name]) => name);
  if (because.length) return { disposition: "fixable_issues", because, open };
  return { disposition: open.length ? null : "no_issues", because: [], open };
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
  dataset: { automated: IAuditAssessment[]; queue: IAuditQueueRow[]; crops: IAuditCrop[]; images: IAuditImage[] },
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
    queue: dataset.queue.filter((q) => q.check_key === run.check_key),
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
