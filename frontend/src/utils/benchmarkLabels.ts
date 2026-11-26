/** Benchmark labels (docs/audit-checks.md, Benchmarks): a target's one label (the latest person
 * answer, whoever gave it), which targets a filter steps through, and the dataset evaluation answer
 * as a person row. A crop's answer and
 * its rows (the DT-1272 gold rows' shape) come from utils/cropAnswers.ts, shared with the audit. */

import type { AuditVerdict, BenchmarkRef, IAuditAnswerInput, IAuditAssessment } from "../types/auditChecks";
import { evaluationFlags, keepsDataset, type EvaluationFlag } from "./auditChecks";


/** The same benchmark: one check, and for prediction quality one layer. */
export const sameBenchmark = (a: BenchmarkRef, b: BenchmarkRef) => a.check_key === b.check_key && a.layer === b.layer;

/** A target's label: the latest person row per layer, whoever gave it ("can't tell" is the crop's
 * image row). A new answer replaces the label; there is one per target, not one per labeler. */
export function latestLabel(people: IAuditAssessment[]): IAuditAssessment[] {
	const latest = new Map<string, IAuditAssessment>();
	for (const row of [...people].sort((a, b) => a.id - b.id)) latest.set(`${row.crop_id}:${row.layer}`, row);
	return [...latest.values()];
}

/** The labeling page's two modes: label random new targets, or review the existing labels. */
export type BenchmarkMode = "new" | "review";

/** A target's key in the page's URL: random new targets have no member id yet. */
export const targetKey = (t: { dataset_id: number; crop_id: number | null }) => (t.crop_id !== null ? `crop-${t.crop_id}` : `dataset-${t.dataset_id}`);

/** What a benchmark's targets are called: tiles, or datasets. */
export const targetNoun = (benchmark: BenchmarkRef, n = 2) => `${benchmark.layer ? "tile" : "dataset"}${n === 1 ? "" : "s"}`;

type Labeled = { people: IAuditAssessment[] };
/** Whether the target has its label: anyone answered it. */
export const isLabeled = (target: Labeled) => target.people.length > 0;
/** The latest row of the target's label, for who gave it and when; null without a label. */
export const latestLabelRow = (target: Labeled) => target.people.reduce<IAuditAssessment | null>((a, b) => (!a || b.id > a.id ? b : a), null);

/** Targets stratified across datasets: the first target of each dataset, then the second of
 * each, and so on, so labeling in order covers every dataset before it takes a second crop
 * of one. */
export function stratified<T extends { dataset_id: number }>(targets: T[]): T[] {
	const byDataset = new Map<number, T[]>();
	for (const t of targets) byDataset.set(t.dataset_id, [...(byDataset.get(t.dataset_id) ?? []), t]);
	const groups = [...byDataset.values()];
	const rounds = Math.max(0, ...groups.map((g) => g.length));
	return Array.from({ length: rounds }, (_, round) => groups.flatMap((g) => (round < g.length ? [g[round]] : []))).flat();
}

/** The next target after `currentId` (wrapping) without a label; null when none is left. */
export function nextOpen<T extends Labeled & { id: number }>(targets: T[], currentId: number | null): T | null {
	const start = targets.findIndex((t) => t.id === currentId);
	for (let step = 1; step <= targets.length; step++) {
		const t = targets[(start + step + targets.length) % targets.length];
		if (t.id !== currentId && !isLabeled(t)) return t;
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
	if (!draft.verdict) return { missing: "Pick OK (1), exclude (2) or unsure (U)" };
	if (draft.verdict === "major" && !draft.reason) return { missing: "Excluding needs a reason" };
	const keep = keepsDataset(draft.verdict);
	// no "keep, fix" any more: an earlier answer's minor is stored as ok
	const verdict: AuditVerdict = keep ? "ok" : draft.verdict;
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
