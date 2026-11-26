import type { AuditVerdict, ITileJudgement, ITileReview, PredictionLayer, ProblemTag, TileReviewInput } from "../types/auditChecks";
import { LAYER_MODES, cropFindings } from "./tileFindings";

/** A reviewer's answer to one error type on a tile. Left unanswered, it is saved as no. */
export type ProblemAnswer = "yes" | "no" | "unsure";

/** A reviewer's answer on one prediction layer of a tile, while they work on it. */
export interface ILayerDraft {
	verdict: AuditVerdict;
	problems: Partial<Record<string, ProblemAnswer>>;
}

/** The reviewer's starting point on a tile's layer: the error types a model saw ticked yes, and
 * the verdict major where the check's call is major, minor where a model saw a problem, else ok. */
export function suggestedLayer(judgements: ITileJudgement[], tileId: number, layer: PredictionLayer, callMajor: boolean | null): ILayerDraft {
	const findings = cropFindings(judgements, tileId, layer, null);
	const seen = new Set(findings.flatMap((f) => f.issues.map((i) => i.key)));
	const problems: ILayerDraft["problems"] = {};
	for (const mode of LAYER_MODES[layer]) if (seen.has(mode)) problems[mode] = "yes";
	const major = callMajor ?? findings.some((f) => f.verdict === "major");
	const verdict: AuditVerdict = major ? "major" : Object.keys(problems).length ? "minor" : "ok";
	return { verdict, problems };
}

/** A saved review back as a draft: its tags yes or unsure. */
export function savedLayer(review: Pick<ITileReview, "verdict" | "problems">): ILayerDraft {
	const problems: ILayerDraft["problems"] = {};
	for (const [mode, tag] of Object.entries(review.problems ?? {})) problems[mode] = tag === true ? "yes" : "unsure";
	return { verdict: review.verdict, problems };
}

/** What a draft stores on the layer: its verdict and the error types seen (true) or unsure. */
export function draftReview(draft: ILayerDraft, layer: PredictionLayer): Pick<TileReviewInput, "verdict" | "problems"> {
	const problems: Record<string, ProblemTag> = {};
	for (const mode of LAYER_MODES[layer]) {
		if (draft.problems[mode] === "yes") problems[mode] = true;
		if (draft.problems[mode] === "unsure") problems[mode] = "unsure";
	}
	return { verdict: draft.verdict, problems };
}

/** A layer draft after the reviewer answers one error type: a yes on an ok tile makes it minor. */
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
