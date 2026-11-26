import type { AuditLayer, AuditVerdict, IAuditCheckEvidence, IModeScore } from "../types/auditChecks";

/** The deciding model of the run's version (rule_config.decider, a model name prefix): Haiku unless
 * the version names another. Its answer is the call; the other models are shown, not counted. */
export function decider(evidence: Pick<IAuditCheckEvidence, "run">): string {
	const named = (evidence.run.version?.config?.rule_config as { decider?: unknown } | undefined)?.decider;
	return typeof named === "string" ? named : "haiku";
}

/** The check's call on one crop: its verdict over the asked layers (null when the deciding model
 * could not assess the crop). */
export interface ICropCall {
  verdict: AuditVerdict | null;
}

/** The check's call on a crop and layer, as audit.dataset_results counts it: the deciding model's
 * verdict where it could assess the crop. A model that could not assess the crop says so on the
 * crop's image row. */
function layerCall(evidence: Pick<IAuditCheckEvidence, "run" | "automated">, cropId: number, layer: AuditLayer): ICropCall {
  const rows = evidence.automated.filter((a) => a.crop_id === cropId && a.assessor_kind === "model");
  const unassessable = new Set(rows.filter((r) => r.layer === "image" && r.verdict === "major").map((r) => r.model));
  const judged = rows.filter((r) => r.layer === layer && !unassessable.has(r.model) && r.verdict !== null);
  const deciding = judged.find((r) => (r.model ?? "").startsWith(decider(evidence)));
  return { verdict: deciding?.verdict ?? null };
}

/** From least to most severe: the worst layer gives a crop over several layers its call. */
const SEVERITY: AuditVerdict[] = ["ok", "ambiguous", "minor", "major"];

/** The check's call on a crop over the given layers: the worst layer's verdict. */
export function cropCall(evidence: Pick<IAuditCheckEvidence, "run" | "automated">, cropId: number, layers: AuditLayer[]): ICropCall {
  const calls = layers.map((layer) => layerCall(evidence, cropId, layer));
  const verdicts = calls.map((c) => c.verdict).filter((v): v is AuditVerdict => v !== null);
  const verdict = verdicts.length ? SEVERITY[Math.max(...verdicts.map((v) => SEVERITY.indexOf(v)))] : null;
  return { verdict };
}

/** The check's call on every crop, worked out once: the map's marks and the crop review read it. */
export function cropCalls(evidence: Pick<IAuditCheckEvidence, "run" | "automated" | "crops">, layers: AuditLayer[]): Map<number, ICropCall> {
  const byCrop = new Map<number, IAuditCheckEvidence["automated"]>();
  for (const row of evidence.automated) if (row.crop_id !== null) byCrop.set(row.crop_id, [...(byCrop.get(row.crop_id) ?? []), row]);
  const none: ICropCall = { verdict: null };
  return new Map(evidence.crops.map((c) => [c.id, layers.length ? cropCall({ run: evidence.run, automated: byCrop.get(c.id) ?? [] }, c.id, layers) : none]));
}

/** A prediction layer's crop counts: the check's calls, or with your crop answers in their place
 * (ambiguous counts only your answers). */
export interface ILayerCounts {
  total: number;
  major: number;
  minor: number;
  ok: number;
  ambiguous?: number;
}

/** A prediction layer's crop counts as audit.dataset_results reports them ({total, major, minor,
 * ok} over every crop the run judged), with your answer in place of the check's call on the crops
 * you answered; your ambiguous answers count apart. */
export function layerCounts(
  evidence: Pick<IAuditCheckEvidence, "crops">,
  calls: Map<number, ICropCall>,
  mine: (cropId: number) => AuditVerdict | null,
): Required<ILayerCounts> {
  const counts = { total: 0, major: 0, minor: 0, ok: 0, ambiguous: 0 };
  for (const crop of evidence.crops) {
    const own = mine(crop.id);
    const verdict = own && own !== "unsure" ? own : (calls.get(crop.id)?.verdict ?? null);
    if (verdict === null || verdict === "unsure") continue;
    if (verdict === "ambiguous") counts.ambiguous += 1;
    else {
      counts.total += 1;
      counts[verdict] += 1;
    }
  }
  return counts;
}

/** The prediction check's error types (processor/src/prediction_quality_v1 vocabulary) in words. */
export const MODE_LABELS: Record<string, string> = {
	m0_not_assessable: "Crop not assessable",
	m1_dead_missed: "Dead trees missed",
	m2_dw_on_live_vegetation: "Deadwood on live trees",
	m3_dw_on_non_vegetation: "Deadwood on bare ground",
	m4_dw_on_lying_wood: "Lying wood marked as deadwood",
	m7_dw_artifact: "Broken or cut-off prediction",
	m5_fc_trees_missed: "Trees missed",
	m6_fc_on_non_trees: "Tree cover on non-trees",
	m7_fc_artifact: "Broken or cut-off prediction",
	m9_fc_gaps_filled: "Gaps between crowns not identified",
};

/** The error types a reviewer answers per prediction layer (scripts/audit_import.py LAYER_MODES). */
export const LAYER_MODES = {
	deadwood: ["m1_dead_missed", "m2_dw_on_live_vegetation", "m3_dw_on_non_vegetation", "m4_dw_on_lying_wood", "m7_dw_artifact"],
	forest_cover: ["m5_fc_trees_missed", "m6_fc_on_non_trees", "m9_fc_gaps_filled", "m7_fc_artifact"],
} as const;
export type PredictionLayer = keyof typeof LAYER_MODES;

/** A model's score on an error type; a person's tag (true) has none. */
export const modeScore = (mode: IModeScore | true | null | undefined): IModeScore => (mode && mode !== true ? mode : {});

/** A model saw an error type when it gives it a likelihood of 50 or more. */
const SEEN = 50;

/** A model's short name: "luna-medium" → "Luna", "haiku-5.5" → "Haiku". */
export const modelName = (model: string | null) => (model ? model.split("-")[0].replace(/^\w/, (c) => c.toUpperCase()) : "Model");

/** What one model saw in a crop on one layer. */
export interface ICropFinding {
	model: string;
	/** its verdict is the check's call; the other models are shown only */
	decides: boolean;
	verdict: AuditVerdict | null;
	/** the model's own sentences on the errors */
	errors: string[];
	/** the error types it found likely (50 or more), most likely first, with the share of the crop */
	issues: { key: string; label: string; likelihood: number; areaPct: number | null }[];
}

/** Each model's findings on a crop and layer, the deciding model (a model name prefix) first. */
export function cropFindings(evidence: Pick<IAuditCheckEvidence, "automated">, cropId: number, layer: AuditLayer, deciding = "haiku"): ICropFinding[] {
	const decides = (model: string | null) => (model ?? "").startsWith(deciding);
	return evidence.automated
		.filter((a) => a.crop_id === cropId && a.layer === layer && a.assessor_kind === "model")
		.sort((a, b) => Number(decides(b.model)) - Number(decides(a.model)))
		.map((a) => ({
			model: modelName(a.model),
			decides: decides(a.model),
			verdict: a.verdict,
			errors: Array.isArray(a.details.errors) ? a.details.errors.filter((e): e is string => typeof e === "string" && e.trim() !== "") : [],
			issues: Object.entries(a.modes ?? {})
				.map(([key, m]) => [key, modeScore(m)] as const)
				.filter(([key, m]) => key !== "m0_not_assessable" && (m.likelihood ?? 0) >= SEEN)
				.sort(([, x], [, y]) => (y.likelihood ?? 0) - (x.likelihood ?? 0))
				.map(([key, m]) => ({ key, label: MODE_LABELS[key] ?? key.replace(/^m\d+_/, "").replace(/_/g, " "), likelihood: m.likelihood ?? 0, areaPct: m.area_pct ?? null })),
		}));
}
