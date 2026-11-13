/** Benchmark labels (docs/audit-checks.md, Benchmarks): what a labeler answers on a target, the
 * person rows it is stored as, and how labelers and models compare once you have answered.
 * Person rows follow the DT-1272 gold rows: one row per target and layer, `modes` hold the
 * problems answered yes, `details.unsure_modes` the unsure ones; "can't tell" is an image row
 * `major` with `m0_not_assessable`. */

import type { AuditCheckKey, AuditLayer, AuditVerdict, IAuditAnswerInput, IAuditAssessment } from "../types/auditChecks";
import { evaluationFlags, keepsDataset, type EvaluationFlag } from "./auditChecks";
import { MODE_LABELS } from "./cropCalls";

export type PredictionLayer = "deadwood" | "forest_cover";
export type ModeAnswer = "yes" | "no" | "unsure";

/** The problems asked per layer, in the order of the old labeler (prediction_quality_v1 vocabulary). */
export const LAYER_QUESTIONS: Record<PredictionLayer, string[]> = {
	deadwood: ["m1_dead_missed", "m2_dw_on_live_vegetation", "m3_dw_on_non_vegetation", "m4_dw_on_lying_wood", "m7_dw_artifact"],
	forest_cover: ["m5_fc_trees_missed", "m6_fc_on_non_trees", "m7_fc_artifact"],
};
export const PREDICTION_LAYERS: PredictionLayer[] = ["deadwood", "forest_cover"];
export const questionLabel = (mode: string) => MODE_LABELS[mode] ?? mode;

/** A labeler's answer on one crop, while it is being given. */
export interface ICropDraft {
	cantTell: boolean;
	layers: Record<PredictionLayer, { modes: Record<string, ModeAnswer>; verdict: AuditVerdict | null }>;
}

export const emptyDraft = (): ICropDraft => ({
	cantTell: false,
	layers: { deadwood: { modes: {}, verdict: null }, forest_cover: { modes: {}, verdict: null } },
});

/** One place the cursor can stand: a problem of a layer, or the layer's verdict. */
export interface IQuestion {
	layer: PredictionLayer;
	mode: string | null;
}

export const QUESTIONS: IQuestion[] = PREDICTION_LAYERS.flatMap((layer) => [
	...LAYER_QUESTIONS[layer].map((mode) => ({ layer, mode })),
	{ layer, mode: null },
]);

const withLayer = (draft: ICropDraft, layer: PredictionLayer, change: Partial<ICropDraft["layers"][PredictionLayer]>): ICropDraft => ({
	...draft,
	cantTell: false,
	layers: { ...draft.layers, [layer]: { ...draft.layers[layer], ...change } },
});

/** Answers the problem under the cursor (yes, no, unsure) or, on a verdict row, unsure only. */
export function answerQuestion(draft: ICropDraft, question: IQuestion, answer: ModeAnswer): ICropDraft {
	const layer = draft.layers[question.layer];
	if (question.mode === null) return answer === "unsure" ? withLayer(draft, question.layer, { verdict: "unsure" }) : draft;
	return withLayer(draft, question.layer, { modes: { ...layer.modes, [question.mode]: answer } });
}

export const setVerdict = (draft: ICropDraft, layer: PredictionLayer, verdict: AuditVerdict) => withLayer(draft, layer, { verdict });

/** Every problem of the layer no, verdict OK. */
export const layerFine = (draft: ICropDraft, layer: PredictionLayer) =>
	withLayer(draft, layer, { modes: Object.fromEntries(LAYER_QUESTIONS[layer].map((m) => [m, "no" as const])), verdict: "ok" });

export const wholeCropFine = (draft: ICropDraft) => PREDICTION_LAYERS.reduce(layerFine, draft);

const yeses = (draft: ICropDraft, layer: PredictionLayer) => LAYER_QUESTIONS[layer].filter((m) => draft.layers[layer].modes[m] === "yes");

/** The verdict a layer is saved with: unanswered problems count as no, and a layer without a
 * problem is OK. A layer with a problem needs minor or major (or unsure): null asks for it. */
export function layerVerdict(draft: ICropDraft, layer: PredictionLayer): AuditVerdict | null {
	const verdict = draft.layers[layer].verdict;
	const problems = yeses(draft, layer).length > 0;
	if (verdict === "unsure") return verdict;
	if (problems) return verdict === "minor" || verdict === "major" ? verdict : null;
	return verdict === "minor" || verdict === "major" ? verdict : "ok";
}

export interface ICropTarget {
	datasetId: number;
	cropId: number;
	/** the prediction each overlay shows */
	labelIds: Partial<Record<PredictionLayer, number | null>>;
}

/** The person rows a crop answer is stored as, or what is still missing. A note goes on the image row. */
export function cropAnswerRows(draft: ICropDraft, target: ICropTarget, note = ""): { rows: IAuditAnswerInput[] } | { missing: string } {
	const base = { check_key: "prediction_quality" as const, dataset_id: target.datasetId, run_id: null, crop_id: target.cropId };
	const details = note.trim() ? { note: note.trim() } : {};
	if (draft.cantTell) {
		return { rows: [{ ...base, layer: "image", verdict: "major", modes: { m0_not_assessable: true }, details }] };
	}
	const rows: IAuditAnswerInput[] = [{ ...base, layer: "image", verdict: "ok", modes: {}, details }];
	for (const layer of PREDICTION_LAYERS) {
		const verdict = layerVerdict(draft, layer);
		if (!verdict) return { missing: `${layer === "deadwood" ? "Deadwood" : "Tree cover"}: a problem is marked, so pick minor (2) or major (3)` };
		const unsure = LAYER_QUESTIONS[layer].filter((m) => draft.layers[layer].modes[m] === "unsure");
		rows.push({
			...base,
			layer,
			label_id: target.labelIds[layer] ?? null,
			verdict,
			modes: Object.fromEntries(yeses(draft, layer).map((m) => [m, true])),
			details: unsure.length ? { unsure_modes: unsure } : {},
		});
	}
	return { rows };
}

const unsureModes = (row: IAuditAssessment) => (Array.isArray(row.details.unsure_modes) ? (row.details.unsure_modes as string[]) : []);

/** A person's stored answer on a crop, back as a draft (to show and to change). */
export function draftFromRows(rows: IAuditAssessment[]): ICropDraft | null {
	if (!rows.length) return null;
	const draft = emptyDraft();
	if (rows.some((r) => r.layer === "image" && r.verdict === "major")) return { ...draft, cantTell: true };
	for (const layer of PREDICTION_LAYERS) {
		const row = rows.find((r) => r.layer === layer);
		if (!row) continue;
		const modes = Object.fromEntries(
			LAYER_QUESTIONS[layer].map((m): [string, ModeAnswer] => [m, row.modes?.[m] ? "yes" : unsureModes(row).includes(m) ? "unsure" : "no"]),
		);
		draft.layers[layer] = { modes, verdict: row.verdict };
	}
	return draft;
}

/** The latest rows per person on one target, mine first. */
export function rowsByPerson(people: IAuditAssessment[], userId: string | undefined): Map<string, IAuditAssessment[]> {
	const byPerson = new Map<string, IAuditAssessment[]>();
	if (userId && people.some((p) => p.assessor_user_id === userId)) byPerson.set(userId, []);
	for (const row of people) {
		const id = row.assessor_user_id ?? row.assessor;
		byPerson.set(id, [...(byPerson.get(id) ?? []), row]);
	}
	return byPerson;
}

/** What a person said about a target, reduced to what labelers can disagree on: the image gate
 * and the verdict of each layer. */
function summary(checkKey: AuditCheckKey, rows: IAuditAssessment[]): string {
	if (checkKey === "dataset_evaluation") {
		const row = rows.find((r) => r.layer === "image");
		return row ? (keepsDataset(row.verdict) ? "keep" : row.verdict) : "";
	}
	if (rows.some((r) => r.layer === "image" && r.verdict === "major")) return "cant_tell";
	return PREDICTION_LAYERS.map((layer) => rows.find((r) => r.layer === layer)?.verdict ?? "-").join("/");
}

/** Two or more labelers who answered the target differently (unsure counts as an answer). */
export function labelersDisagree(checkKey: AuditCheckKey, people: IAuditAssessment[]): boolean {
	const answers = new Set([...rowsByPerson(people, undefined).values()].map((rows) => summary(checkKey, rows)));
	return answers.size > 1;
}

/** A model's or another labeler's answer on one problem: yes, no or unsure; a model says yes at 50+. */
export function problemAnswer(row: IAuditAssessment | undefined, mode: string): ModeAnswer | null {
	if (!row) return null;
	const value = row.modes?.[mode] as unknown;
	if (row.assessor_kind === "person") return value ? "yes" : unsureModes(row).includes(mode) ? "unsure" : "no";
	const likelihood = typeof value === "object" && value !== null ? ((value as { likelihood?: number }).likelihood ?? 0) : 0;
	return likelihood >= 50 ? "yes" : "no";
}

export type Agreement = "agree" | "they_flag" | "you_flag" | "other";

/** How another answer compares with yours: agree, they flag what you did not, you flag what they did not. */
export function agreement(mine: ModeAnswer | AuditVerdict | null, theirs: ModeAnswer | AuditVerdict | null): Agreement | null {
	if (!mine || !theirs) return null;
	if (mine === theirs) return "agree";
	const flags = (a: string) => a === "yes" || a === "minor" || a === "major";
	if (flags(theirs) && !flags(mine)) return "they_flag";
	if (flags(mine) && !flags(theirs)) return "you_flag";
	return "other";
}

/** The dataset evaluation answer of the review page, given on a benchmark target. */
export interface IEvaluationDraft {
	verdict: AuditVerdict | null;
	reason: string | null;
	flags: EvaluationFlag[];
	note: string;
}

export const emptyEvaluationDraft = (): IEvaluationDraft => ({ verdict: null, reason: null, flags: [], note: "" });

export function evaluationDraftFromRow(row: IAuditAssessment | undefined): IEvaluationDraft | null {
	if (!row) return null;
	return { verdict: row.verdict, reason: row.reason_code, flags: evaluationFlags(row), note: row.reason_text ?? "" };
}

/** The person row a dataset evaluation answer is stored as (as on the review page), or what is missing. */
export function evaluationAnswerRow(draft: IEvaluationDraft, datasetId: number): { rows: IAuditAnswerInput[] } | { missing: string } {
	if (!draft.verdict) return { missing: "Pick keep (1), keep but fix (2), exclude (3) or unsure (U)" };
	if (draft.verdict === "major" && !draft.reason) return { missing: "Excluding needs a reason" };
	const keep = keepsDataset(draft.verdict);
	// a kept dataset with a fix flag is "keep, fix"; without one it is "keep"
	const verdict: AuditVerdict = keep ? (draft.flags.length ? "minor" : draft.verdict) : draft.verdict;
	return {
		rows: [
			{
				check_key: "dataset_evaluation",
				dataset_id: datasetId,
				run_id: null,
				crop_id: null,
				layer: "image" as AuditLayer,
				verdict,
				reason_code: verdict === "major" ? draft.reason : null,
				reason_text: draft.note.trim() || null,
				details: { fix_flags: keep ? draft.flags : [] },
			},
		],
	};
}

export type BenchmarkFilter = "open" | "all" | "disagree";
export const BENCHMARK_FILTERS: { value: BenchmarkFilter; label: string }[] = [
	{ value: "open", label: "Open for me" },
	{ value: "all", label: "All" },
	{ value: "disagree", label: "Labelers disagree" },
];

type Labeled = { people: IAuditAssessment[] };
export const answeredBy = (target: Labeled, userId: string | undefined) => !!userId && target.people.some((p) => p.assessor_user_id === userId);

/** The targets a filter steps through. `keep` holds targets answered in this session, so an
 * answer does not pull the crop out from under you while "open for me" is on. */
export function filterTargets<T extends Labeled & { id: number }>(
	targets: T[],
	filter: BenchmarkFilter,
	checkKey: AuditCheckKey,
	userId: string | undefined,
	keep: ReadonlySet<number> = new Set(),
): T[] {
	const passes = (t: T) =>
		filter === "all" || (filter === "open" ? !answeredBy(t, userId) : labelersDisagree(checkKey, t.people));
	return targets.filter((t) => passes(t) || keep.has(t.id));
}

/** The next target after `currentId` (wrapping) that you have not answered; null when none is left. */
export function nextOpen<T extends Labeled & { id: number }>(targets: T[], currentId: number | null, userId: string | undefined): T | null {
	const start = targets.findIndex((t) => t.id === currentId);
	for (let step = 1; step <= targets.length; step++) {
		const t = targets[(start + step + targets.length) % targets.length];
		if (!answeredBy(t, userId)) return t;
	}
	return null;
}
