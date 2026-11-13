import type { AuditLayer, AuditVerdict, IAuditAnswerInput, IAuditAssessment } from "../types/auditChecks";
import { myAnswer } from "./auditChecks";
import { LAYER_MODES, modeScore, type PredictionLayer } from "./cropCalls";

/** A reviewer's answer to one error type on a crop. Left unanswered, it is saved as no. */
export type ProblemAnswer = "yes" | "no" | "unsure";

/** A reviewer's answer on one prediction layer of a crop, while they work on it. */
export interface ILayerDraft {
	verdict: AuditVerdict;
	problems: Partial<Record<string, ProblemAnswer>>;
}

/** A reviewer's answer on a crop: "can't tell what it shows", or one answer per layer. */
export type CropDraft = { assessable: false } | { assessable: true; layers: Partial<Record<PredictionLayer, ILayerDraft>> };

/** What the reviewer's draft stores, as person rows (the 581 gold rows' format, scripts/audit_import.py
 * person_rows): the crop's image row (assessable: ok with no tags; can't tell: major, tagged
 * m0_not_assessable), then, when assessable, one row per answered layer with the error types
 * they saw tagged true and the ones they were unsure of in details.unsure_modes. */
export type CropAnswerRow = Pick<IAuditAnswerInput, "layer" | "verdict" | "modes" | "details">;

/** A model saw an error type when it gives it a likelihood of 50 or more. */
const SEEN = 50;

/** The reviewer's starting point on a crop's layer: the error types a model saw ticked yes, and
 * the verdict major where the check counted the crop major, minor where a model saw a problem,
 * else ok. */
export function suggestedLayer(automated: IAuditAssessment[], cropId: number, layer: PredictionLayer, checkMajor: boolean | null): ILayerDraft {
	const rows = automated.filter((a) => a.crop_id === cropId && a.layer === layer && a.assessor_kind === "model");
	const problems: ILayerDraft["problems"] = {};
	for (const mode of LAYER_MODES[layer]) if (rows.some((r) => (modeScore(r.modes?.[mode]).likelihood ?? 0) >= SEEN)) problems[mode] = "yes";
	const modelMajor = checkMajor ?? rows.some((r) => r.verdict === "major");
	const verdict: AuditVerdict = modelMajor ? "major" : Object.keys(problems).length ? "minor" : "ok";
	return { verdict, problems };
}

/** A saved person row back as a draft: its tags yes, its unsure_modes unsure. */
export function savedLayer(row: IAuditAssessment): ILayerDraft {
	const problems: ILayerDraft["problems"] = {};
	for (const [mode, tag] of Object.entries(row.modes ?? {})) if (tag === true) problems[mode] = "yes";
	const unsure = Array.isArray(row.details?.unsure_modes) ? (row.details.unsure_modes as unknown[]) : [];
	for (const mode of unsure) if (typeof mode === "string") problems[mode] = "unsure";
	return { verdict: row.verdict, problems };
}

/** The reviewer said they cannot tell what the crop shows: their latest image row on it. */
export const cantTell = (imageRow: IAuditAssessment | null | undefined) => imageRow?.verdict === "major";

/** The person rows a draft stores (CropAnswerRow). */
export function cropAnswerRows(draft: CropDraft): CropAnswerRow[] {
	if (!draft.assessable) return [{ layer: "image", verdict: "major", modes: { m0_not_assessable: true } }];
	const layers = Object.entries(draft.layers) as [PredictionLayer, ILayerDraft][];
	return [
		{ layer: "image", verdict: "ok", modes: {} },
		...layers.map(([layer, { verdict, problems }]): CropAnswerRow => {
			const modes: Record<string, true> = {};
			const unsure: string[] = [];
			for (const mode of LAYER_MODES[layer]) {
				if (problems[mode] === "yes") modes[mode] = true;
				if (problems[mode] === "unsure") unsure.push(mode);
			}
			return { layer: layer as AuditLayer, verdict, modes, details: unsure.length ? { unsure_modes: unsure } : {} };
		}),
	];
}

/** A layer draft after the reviewer answers one error type: a yes on an ok crop makes it minor. */
export function withProblem(draft: ILayerDraft, mode: string, answer: ProblemAnswer): ILayerDraft {
	const problems = { ...draft.problems, [mode]: answer };
	return { verdict: answer === "yes" && draft.verdict === "ok" ? "minor" : draft.verdict, problems };
}

/** A layer draft after the reviewer gives its verdict: ok means none of the error types is there. */
export function withVerdict(draft: ILayerDraft, verdict: AuditVerdict): ILayerDraft {
	if (verdict !== "ok") return { ...draft, verdict };
	const problems = Object.fromEntries(Object.entries(draft.problems).map(([mode, a]) => [mode, a === "yes" ? "no" : a]));
	return { verdict, problems };
}

/** Your verdict on a crop's layer for the layer rating: "unsure" when you can't tell what the crop
 * shows (it does not count), null when you have not answered. */
export function myCropVerdict(people: IAuditAssessment[], userId: string | undefined, runId: number, layer: AuditLayer) {
	return (cropId: number): AuditVerdict | null => {
		const target = (l: AuditLayer) => ({ checkKey: "prediction_quality" as const, layer: l, cropId });
		if (cantTell(myAnswer(people, userId, runId, target("image")))) return "unsure";
		return myAnswer(people, userId, runId, target(layer))?.verdict ?? null;
	};
}
