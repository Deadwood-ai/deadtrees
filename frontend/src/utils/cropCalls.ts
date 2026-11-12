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
function cropMajor(evidence: Pick<IAuditCheckEvidence, "run" | "automated">, cropId: number, layer: AuditLayer): boolean | null {
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
