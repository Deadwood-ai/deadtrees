import type { AuditLayer, AuditVerdict, IAuditCheckEvidence } from "../types/auditChecks";
import { orderedCrops } from "./auditChecks";

/** The rule config key of a layer (processor/src/prediction_quality_v1/rule.py, RULE_CONFIG). */
const CUT_KEY: Partial<Record<AuditLayer, string>> = { deadwood: "deadwood", forest_cover: "forest" };

/** The cut-off the run's version counts a crop major at, on one layer; null when it has none. */
function majorCut(evidence: Pick<IAuditCheckEvidence, "run">, layer: AuditLayer): number | null {
	const cuts = (evidence.run.version?.config?.rule_config as { crop_major_cut?: Record<string, number> } | undefined)?.crop_major_cut;
	const cut = cuts?.[CUT_KEY[layer] ?? ""];
	return typeof cut === "number" ? cut : null;
}

/** Whether the check counted a crop major on one layer, as its rule does: the mean major
 * likelihood of the models that could assess the crop reaches the version's cut-off. A model
 * that could not assess the crop says so on the crop's image row. Null when nothing decides. */
export function cropMajor(evidence: Pick<IAuditCheckEvidence, "run" | "automated">, cropId: number, layer: AuditLayer): boolean | null {
	const cut = majorCut(evidence, layer);
	if (cut === null) return null;
	const rows = evidence.automated.filter((a) => a.crop_id === cropId && a.assessor_kind === "model");
	const unassessable = new Set(rows.filter((r) => r.layer === "image" && r.verdict === "major").map((r) => r.model));
	const scores = rows
		.filter((r) => r.layer === layer && !unassessable.has(r.model) && typeof r.major_likelihood === "number")
		.map((r) => r.major_likelihood as number);
	if (!scores.length) return null;
	return scores.reduce((sum, s) => sum + s, 0) / scores.length >= cut;
}

/** The check's call on a crop over the given layers: major when the rule counted it major on
 * any of them, ok when on none, null when the run has no cut-offs or no judged answers. */
export function cropCall(evidence: Pick<IAuditCheckEvidence, "run" | "automated">, cropId: number, layers: AuditLayer[]): AuditVerdict | null {
	const calls = layers.map((layer) => cropMajor(evidence, cropId, layer)).filter((c): c is boolean => c !== null);
	if (!calls.length) return null;
	return calls.some(Boolean) ? "major" : "ok";
}

/** The check's call on every crop, worked out once: the map's marks, the review order and the
 * flagged list all read it. */
export function cropCalls(evidence: Pick<IAuditCheckEvidence, "run" | "automated" | "crops">, layers: AuditLayer[]): Map<number, AuditVerdict | null> {
	const byCrop = new Map<number, IAuditCheckEvidence["automated"]>();
	for (const row of evidence.automated) if (row.crop_id !== null) byCrop.set(row.crop_id, [...(byCrop.get(row.crop_id) ?? []), row]);
	return new Map(evidence.crops.map((c) => [c.id, layers.length ? cropCall({ run: evidence.run, automated: byCrop.get(c.id) ?? [] }, c.id, layers) : null]));
}

/** The crops in review order: the ones the check counted major first, then the page's usual
 * order (the sort is stable). */
export function cropsForReview(evidence: Pick<IAuditCheckEvidence, "crops">, calls: Map<number, AuditVerdict | null>): IAuditCheckEvidence["crops"] {
	const major = (id: number) => (calls.get(id) === "major" ? 0 : 1);
	return orderedCrops(evidence).sort((a, b) => major(a.id) - major(b.id));
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
};

/** The error types a reviewer answers per prediction layer (scripts/audit_import.py LAYER_MODES). */
export const LAYER_MODES = {
	deadwood: ["m1_dead_missed", "m2_dw_on_live_vegetation", "m3_dw_on_non_vegetation", "m4_dw_on_lying_wood", "m7_dw_artifact"],
	forest_cover: ["m5_fc_trees_missed", "m6_fc_on_non_trees", "m7_fc_artifact"],
} as const;
export type PredictionLayer = keyof typeof LAYER_MODES;

/** A model's score on an error type; a person's tag (true) has none. */
export const modeScore = (mode: unknown) => (typeof mode === "object" && mode !== null ? (mode as { likelihood?: number; area_pct?: number }) : {});

/** A model's short name: "luna-medium" → "Luna", "haiku-5.5" → "Haiku". */
const modelName = (model: string | null) => (model ? model.split("-")[0].replace(/^\w/, (c) => c.toUpperCase()) : "Model");

/** What one model saw in a crop on one layer. */
export interface ICropFinding {
	model: string;
	verdict: AuditVerdict;
	/** the model's own sentences on the errors */
	errors: string[];
	/** the error types it found likely (50 or more), most likely first, with the share of the crop */
	issues: { key: string; label: string; likelihood: number; areaPct: number | null }[];
}

/** Each model's findings on a crop and layer, the model that saw the worst first. */
export function cropFindings(evidence: Pick<IAuditCheckEvidence, "automated">, cropId: number, layer: AuditLayer): ICropFinding[] {
	return evidence.automated
		.filter((a) => a.crop_id === cropId && a.layer === layer && a.assessor_kind === "model")
		.sort((a, b) => (b.major_likelihood ?? 0) - (a.major_likelihood ?? 0))
		.map((a) => ({
			model: modelName(a.model),
			verdict: a.verdict,
			errors: Array.isArray(a.details.errors) ? a.details.errors.filter((e): e is string => typeof e === "string" && e.trim() !== "") : [],
			issues: Object.entries(a.modes ?? {})
				.map(([key, m]) => [key, modeScore(m)] as const)
				.filter(([key, m]) => key !== "m0_not_assessable" && (m.likelihood ?? 0) >= 50)
				.sort(([, x], [, y]) => (y.likelihood ?? 0) - (x.likelihood ?? 0))
				.map(([key, m]) => ({ key, label: MODE_LABELS[key] ?? key.replace(/^m\d+_/, "").replace(/_/g, " "), likelihood: m.likelihood ?? 0, areaPct: m.area_pct ?? null })),
		}));
}

/** A prediction layer's saved rating, worked out from its crops: per crop your answer, else the
 * check's call, counted over the crops the check counts (its exclude set, or all when it has none).
 * Two or more major crops make it bad, one makes it ok, none great. The audit asks no question on
 * the whole layer; each use downstream can read the crop answers with its own rule. */
export function layerRatingFromCrops(
	evidence: Pick<IAuditCheckEvidence, "crops">,
	calls: Map<number, AuditVerdict | null>,
	mine: (cropId: number) => AuditVerdict | null,
): { quality: "great" | "sentinel_ok" | "bad"; major: number; counted: number } | null {
	const counted = evidence.crops.some((c) => c.crop_sets.includes("exclude")) ? evidence.crops.filter((c) => c.crop_sets.includes("exclude")) : evidence.crops;
	const verdicts = counted.map((c) => mine(c.id) ?? calls.get(c.id) ?? null).filter((v): v is AuditVerdict => v !== null && v !== "unsure");
	if (!verdicts.length) return null;
	const major = verdicts.filter((v) => v === "major").length;
	return { quality: major >= 2 ? "bad" : major === 1 ? "sentinel_ok" : "great", major, counted: verdicts.length };
}
