/** Benchmark labels (docs/audit-checks.md, Benchmarks): how labelers compare, which targets a
 * filter steps through, and the dataset evaluation answer as a person row. A crop's answer and
 * its rows (the DT-1272 gold rows' shape) come from utils/cropAnswers.ts, shared with the audit. */

import type { AuditCheckKey, AuditVerdict, IAuditAnswerInput, IAuditAssessment } from "../types/auditChecks";
import { evaluationFlags, keepsDataset, type EvaluationFlag } from "./auditChecks";
import { LAYER_MODES, type PredictionLayer } from "./cropCalls";

export const PREDICTION_LAYERS = Object.keys(LAYER_MODES) as PredictionLayer[];

/** The latest rows per person on one target. */
export function rowsByPerson(people: IAuditAssessment[]): Map<string, IAuditAssessment[]> {
	const byPerson = new Map<string, IAuditAssessment[]>();
	for (const row of people) {
		const id = row.assessor_user_id ?? row.assessor;
		byPerson.set(id, [...(byPerson.get(id) ?? []), row]);
	}
	return byPerson;
}

/** A crop answer reduced to what labelers can disagree on: "can't tell", or each layer's verdict. */
export function cropVerdicts(rows: IAuditAssessment[]): "cant_tell" | Partial<Record<PredictionLayer, AuditVerdict>> {
	if (rows.some((r) => r.layer === "image" && r.verdict === "major")) return "cant_tell";
	return Object.fromEntries(PREDICTION_LAYERS.flatMap((layer) => rows.filter((r) => r.layer === layer).map((r) => [layer, r.verdict])));
}

function summary(checkKey: AuditCheckKey, rows: IAuditAssessment[]): string {
	if (checkKey === "dataset_evaluation") {
		const row = rows.find((r) => r.layer === "image");
		return row ? (keepsDataset(row.verdict) ? "keep" : row.verdict) : "";
	}
	const verdicts = cropVerdicts(rows);
	return verdicts === "cant_tell" ? verdicts : PREDICTION_LAYERS.map((l) => verdicts[l] ?? "-").join("/");
}

/** Two or more labelers who answered the target differently (unsure counts as an answer). */
export function labelersDisagree(checkKey: AuditCheckKey, people: IAuditAssessment[]): boolean {
	return new Set([...rowsByPerson(people).values()].map((rows) => summary(checkKey, rows))).size > 1;
}

export type Agreement = "agree" | "they_flag" | "you_flag" | "other";

/** How another verdict compares with yours: the same, they find a problem you did not, or the reverse. */
export function agreement(mine: AuditVerdict | null | undefined, theirs: AuditVerdict | null | undefined): Agreement | null {
	if (!mine || !theirs) return null;
	if (mine === theirs) return "agree";
	const flags = (v: AuditVerdict) => v === "minor" || v === "major";
	if (flags(theirs) && !flags(mine)) return "they_flag";
	if (flags(mine) && !flags(theirs)) return "you_flag";
	return "other";
}

export type BenchmarkFilter = "open" | "all" | "disagree";
export const BENCHMARK_FILTERS: { value: BenchmarkFilter; label: string }[] = [
	{ value: "open", label: "Open for me" },
	{ value: "all", label: "All" },
	{ value: "disagree", label: "Labelers disagree" },
];

type Labeled = { people: IAuditAssessment[] };
export const answeredBy = (target: Labeled, userId: string | undefined) => !!userId && target.people.some((p) => p.assessor_user_id === userId);

/** The targets a filter steps through. `keep` holds targets answered in this visit, so an answer
 * does not pull the target out from under you while "open for me" is on. */
export function filterTargets<T extends Labeled & { id: number }>(
	targets: T[],
	filter: BenchmarkFilter,
	checkKey: AuditCheckKey,
	userId: string | undefined,
	keep: ReadonlySet<number> = new Set(),
): T[] {
	const passes = (t: T) => filter === "all" || (filter === "open" ? !answeredBy(t, userId) : labelersDisagree(checkKey, t.people));
	return targets.filter((t) => passes(t) || keep.has(t.id));
}

/** The next target after `currentId` (wrapping) that you have not answered; null when none is left. */
export function nextOpen<T extends Labeled & { id: number }>(targets: T[], currentId: number | null, userId: string | undefined): T | null {
	const start = targets.findIndex((t) => t.id === currentId);
	for (let step = 1; step <= targets.length; step++) {
		const t = targets[(start + step + targets.length) % targets.length];
		if (t.id !== currentId && !answeredBy(t, userId)) return t;
	}
	return null;
}

/** The dataset evaluation answer of the review page, given on a benchmark target. */
export interface IEvaluationDraft {
	verdict: AuditVerdict | null;
	reason: string | null;
	flags: EvaluationFlag[];
	note: string;
}

export const emptyEvaluationDraft = (): IEvaluationDraft => ({ verdict: null, reason: null, flags: [], note: "" });

export function evaluationDraftFromRow(row: IAuditAssessment | null | undefined): IEvaluationDraft | null {
	if (!row) return null;
	return { verdict: row.verdict, reason: row.reason_code, flags: evaluationFlags(row), note: row.reason_text ?? "" };
}

/** The person row a dataset evaluation answer is stored as (as on the review page), or what is
 * missing. The run is the caller's: the one that judged the dataset, if any. */
export function evaluationAnswerRow(draft: IEvaluationDraft, datasetId: number, runId: number | null): { row: IAuditAnswerInput } | { missing: string } {
	if (!draft.verdict) return { missing: "Pick keep (1), keep but fix (2), exclude (3) or unsure (U)" };
	if (draft.verdict === "major" && !draft.reason) return { missing: "Excluding needs a reason" };
	const keep = keepsDataset(draft.verdict);
	// a kept dataset with a fix flag is "keep, fix"
	const verdict: AuditVerdict = keep && draft.flags.length ? "minor" : draft.verdict;
	return {
		row: {
			check_key: "dataset_evaluation",
			dataset_id: datasetId,
			run_id: runId,
			crop_id: null,
			layer: "image",
			verdict,
			reason_code: verdict === "major" ? draft.reason : null,
			reason_text: draft.note.trim() || null,
			details: { fix_flags: keep ? draft.flags : [] },
		},
	};
}
