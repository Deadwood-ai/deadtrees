import type { AuditVerdict, IProblemScore, ITileJudgement, PredictionLayer } from "../types/auditChecks";
import { judgeName } from "./auditChecks";

/** The prediction check's error types (processor/src/prediction_quality_v1 vocabulary) in words. */
export const MODE_LABELS: Record<string, string> = {
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

/** The error types a reviewer answers per prediction layer. */
export const LAYER_MODES: Record<PredictionLayer, readonly string[]> = {
	deadwood: ["m1_dead_missed", "m2_dw_on_live_vegetation", "m3_dw_on_non_vegetation", "m4_dw_on_lying_wood", "m7_dw_artifact"],
	forest_cover: ["m5_fc_trees_missed", "m6_fc_on_non_trees", "m9_fc_gaps_filled", "m7_fc_artifact"],
};

/** A model saw an error type when it gives it a likelihood of 50 or more. */
const SEEN = 50;

/** What one model saw in a tile on one layer. */
export interface ICropFinding {
	model: string;
	/** its verdict is the check's call; the other models are shown only */
	decides: boolean;
	verdict: AuditVerdict;
	/** the model's own sentence on the tile */
	summary: string | null;
	/** the error types it found likely (50 or more), most likely first, with the share of the tile */
	issues: { key: string; label: string; likelihood: number; areaPct: number | null }[];
}

/** The error types a model found likely, most likely first. */
export function seenProblems(problems: Record<string, IProblemScore> | null): ICropFinding["issues"] {
	return Object.entries(problems ?? {})
		.filter(([key, m]) => key in MODE_LABELS && (m.likelihood ?? 0) >= SEEN)
		.sort(([, x], [, y]) => (y.likelihood ?? 0) - (x.likelihood ?? 0))
		.map(([key, m]) => ({ key, label: MODE_LABELS[key], likelihood: m.likelihood ?? 0, areaPct: m.area_pct ?? null }));
}

/** Each model's findings on a tile and layer, the deciding answer (the tile call's judgement_id) first. */
export function cropFindings(judgements: ITileJudgement[], tileId: number, layer: PredictionLayer, decidingId: number | null): ICropFinding[] {
	return judgements
		.filter((j) => j.tile_id === tileId && j.layer === layer)
		.sort((a, b) => Number(b.id === decidingId) - Number(a.id === decidingId))
		.map((j) => ({
			model: judgeName(j.judge),
			decides: j.id === decidingId,
			verdict: j.verdict,
			summary: j.summary?.trim() || null,
			issues: seenProblems(j.problems),
		}));
}
