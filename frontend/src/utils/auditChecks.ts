/** How the audit page reads the automated checks: section order, verdict labels,
 * status, the answer a reviewer gives and the decision derived from the sections. */

import type { AuditFormValues, DatasetDisposition, PredictionQuality } from "../hooks/useDatasetAudit";
import type {
  AuditCheckKey,
  AuditLayer,
  AuditVerdict,
  IAuditAssessment,
  IAuditCheckEvidence,
} from "../types/auditChecks";

export type AuditSectionId = "evaluation" | "aoi" | "georef" | "date" | "phenology" | "prediction";
/** What the map shows while a section is open. */
export type AuditMapMode = "default" | "evaluation" | "georef" | "prediction";

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
  mapMode: AuditMapMode;
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
    mapMode: "evaluation",
    reasons: [
      { code: "exclude_call_wrong", label: "Keep or exclude call wrong" },
      { code: "fix_call_wrong", label: "COG or thumbnail call wrong" },
      { code: "image_facts_wrong", label: "Image facts wrong" },
      OTHER,
    ],
    verdicts: ["ok", "minor", "major"],
    fields: ["has_cog_issue", "has_thumbnail_issue"],
  },
  { id: "aoi", title: "Area of interest", checkKey: null, layers: [], mapMode: "default", reasons: [], verdicts: [], fields: [] },
  {
    id: "georef",
    title: "Georeferencing",
    checkKey: "georef",
    layers: ["georef"],
    mapMode: "georef",
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
    mapMode: "default",
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
    mapMode: "default",
    reasons: [],
    verdicts: [],
    fields: ["has_valid_phenology"],
  },
  {
    id: "prediction",
    title: "Prediction quality",
    checkKey: "prediction_quality",
    layers: ["deadwood", "forest_cover"],
    mapMode: "prediction",
    reasons: [
      { code: "errors_missed", label: "Model missed errors" },
      { code: "fine_prediction_flagged", label: "Model flagged a fine prediction" },
      { code: "crops_not_representative", label: "Crops not representative" },
      OTHER,
    ],
    verdicts: ["ok", "minor", "major"],
    fields: ["deadwood_quality", "forest_cover_quality"],
  },
];

export const auditSection = (id: AuditSectionId) => AUDIT_SECTIONS.find((s) => s.id === id)!;

/** The section that holds a saved-audit field, if any (the final assessment sits above the sections). */
export const sectionOfField = (field: string): AuditSectionId | null =>
  AUDIT_SECTIONS.find((s) => (s.fields as string[]).includes(field))?.id ?? null;

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

export type AuditTone = "ok" | "warn" | "bad" | "todo";

export const VERDICT_TONE: Record<AuditVerdict, AuditTone> = { ok: "ok", minor: "warn", major: "bad", unsure: "warn" };

const SEVERITY: AuditVerdict[] = ["ok", "minor", "unsure", "major"];
const worst = (verdicts: AuditVerdict[]) =>
  verdicts.reduce<AuditVerdict | null>((w, v) => (w === null || SEVERITY.indexOf(v) > SEVERITY.indexOf(w) ? v : w), null);

/** The check's dataset-level call on a layer: the review queue's verdict, else the worst
 * dataset-level rule row (or model row when the run has no rule), as the queue computes it. */
export function automatedVerdict(evidence: IAuditCheckEvidence | undefined, layer: AuditLayer): AuditVerdict | null {
  if (!evidence) return null;
  const queued = evidence.queue.find((q) => q.layer === layer);
  if (queued) return queued.verdict;
  const rows = evidence.automated.filter((a) => a.crop_id === null && a.layer === layer);
  const rules = rows.filter((a) => a.assessor_kind === "rule");
  return worst((rules.length ? rules : rows).map((a) => a.verdict));
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

export interface IAuditSectionStatus {
  label: string;
  tone: AuditTone;
  needsYou: boolean;
}

/** The badge of a section with a check: not run, needs you, answered, or the call itself. */
export function sectionStatus(
  section: IAuditSectionDef,
  evidence: IAuditCheckEvidence | undefined,
  answered: boolean,
): IAuditSectionStatus {
  if (!section.checkKey || !evidence) return { label: "Not run yet", tone: "todo", needsYou: false };
  const verdict = worst(section.layers.map((l) => automatedVerdict(evidence, l)).filter((v): v is AuditVerdict => v !== null));
  // each reviewer answers on their own: a result under review needs you until you answered,
  // whoever else did (the queue's needs_review clears with the first answer)
  const needsReview = evidence.queue.some((q) => q.reason !== null && section.layers.includes(q.layer));
  if (needsReview && !answered) return { label: "Needs you", tone: verdict === "major" ? "bad" : "warn", needsYou: true };
  if (answered) return { label: "Answered", tone: "ok", needsYou: false };
  if (!verdict) return { label: "No call", tone: "todo", needsYou: false };
  return { label: verdictLabel(section.checkKey, verdict), tone: VERDICT_TONE[verdict], needsYou: false };
}

/** The verdict "Check wrong" stores for a two-way call; null where the reviewer must pick one. */
export function wrongVerdict(verdict: AuditVerdict): AuditVerdict | null {
  if (verdict === "ok") return "major";
  if (verdict === "major" || verdict === "minor") return "ok";
  return null;
}

const QUALITY_VERDICT: Record<PredictionQuality, AuditVerdict> = { great: "ok", sentinel_ok: "minor", bad: "major" };
const VERDICT_QUALITY: Partial<Record<AuditVerdict, PredictionQuality>> = { ok: "great", minor: "sentinel_ok", major: "bad" };
const QUALITY_FIELD: Partial<Record<AuditLayer, "deadwood_quality" | "forest_cover_quality">> = {
  deadwood: "deadwood_quality",
  forest_cover: "forest_cover_quality",
};

const likely = (modes: Record<string, unknown> | undefined, key: string) => {
  const mode = modes?.[key] as { likelihood?: number } | undefined;
  return mode?.likelihood === undefined ? undefined : mode.likelihood >= 50;
};

/** The saved-audit fields an answer sets, so the form and the answer stay the same. */
export function formValuesForVerdict(
  checkKey: AuditCheckKey,
  layer: AuditLayer,
  verdict: AuditVerdict,
  rows: IAuditAssessment[] = [],
): Partial<AuditFormValues> {
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
    case "dataset_evaluation": {
      if (verdict === "major") return {};
      const modes = rows.find((r) => r.assessor_kind === "rule")?.modes ?? rows[0]?.modes;
      const cog = verdict === "ok" ? false : likely(modes, "cog_issue");
      const thumbnail = verdict === "ok" ? false : likely(modes, "thumbnail_issue");
      return {
        ...(cog === undefined ? {} : { has_cog_issue: cog }),
        ...(thumbnail === undefined ? {} : { has_thumbnail_issue: thumbnail }),
      };
    }
  }
}

/** The reviewer's own verdict as the saved-audit form holds it, where the form has one. */
export function formVerdict(checkKey: AuditCheckKey, layer: AuditLayer, values: Partial<AuditFormValues>): AuditVerdict | null {
  switch (checkKey) {
    case "georef":
      return values.is_georeferenced === undefined || values.is_georeferenced === null ? null : values.is_georeferenced ? "ok" : "major";
    case "acquisition_date":
      return values.has_valid_acquisition_date === undefined || values.has_valid_acquisition_date === null
        ? null
        : values.has_valid_acquisition_date
          ? "ok"
          : "major";
    case "prediction_quality": {
      const field = QUALITY_FIELD[layer];
      const quality = field ? values[field] : undefined;
      return quality ? QUALITY_VERDICT[quality] : null;
    }
    case "dataset_evaluation":
      return null;
  }
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
    [evaluation === "minor", "dataset evaluation: keep, fix"],
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

const CROP_SET_ORDER = ["exclude", "evaluation", "training", "benchmark"];
const firstSet = (sets: string[]) => Math.min(...sets.map((s) => (CROP_SET_ORDER.indexOf(s) + 1 || 9)));

/** The crops a check judged, in the order the page numbers them: the exclude set first. */
export function orderedCrops(evidence: IAuditCheckEvidence | undefined): IAuditCheckEvidence["crops"] {
  return [...(evidence?.crops ?? [])].sort((a, b) => firstSet(a.crop_sets) - firstSet(b.crop_sets) || a.id - b.id);
}

/** The models' worst call on one crop and layer (or on any of the given layers). */
export function cropModelVerdict(evidence: IAuditCheckEvidence | undefined, cropId: number, layers: AuditLayer[]): AuditVerdict | null {
  return worst(
    (evidence?.automated ?? []).filter((a) => a.crop_id === cropId && layers.includes(a.layer)).map((a) => a.verdict),
  );
}

/** The audit page section that shows a check. */
export function sectionOfCheck(checkKey: AuditCheckKey): AuditSectionId {
  return AUDIT_SECTIONS.find((s) => s.checkKey === checkKey)!.id;
}

/** The saved-audit fields the reviewer's own answers on the current runs imply. */
export function answeredFormValues(checks: { checks: Partial<Record<AuditCheckKey, IAuditCheckEvidence>>; people: IAuditAssessment[] } | undefined, userId: string | undefined): Partial<AuditFormValues> {
  if (!checks || !userId) return {};
  return AUDIT_SECTIONS.reduce<Partial<AuditFormValues>>((values, section) => {
    const evidence = section.checkKey ? checks.checks[section.checkKey] : undefined;
    if (!evidence) return values;
    for (const layer of section.layers) {
      const mine = myAnswer(checks.people, userId, evidence.run.id, { checkKey: section.checkKey!, layer });
      if (mine) Object.assign(values, formValuesForVerdict(section.checkKey!, layer, mine.verdict, automatedRows(evidence, layer)));
    }
    return values;
  }, {});
}
