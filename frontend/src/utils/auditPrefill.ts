import type { IAuditSuggestion } from "../types/acquisitionDate";
import type { AuditCheckKey, AuditLayer, AuditVerdict, IAuditAnswerInput, IAuditChecks } from "../types/auditChecks";
import type { AuditFormValues } from "../hooks/useDatasetAudit";
import {
	AUDIT_SECTIONS,
	EVALUATION_FLAGS,
	automatedRows,
	automatedVerdict,
	evaluationFlags,
	formValuesForVerdict,
	keepsDataset,
	myAnswer,
	type EvaluationFlag,
} from "./auditChecks";

/** The form keeps step 1's "needs reprocessing" draft under this key. It has no field in the saved
 * audit, so it never reaches the audit row; the answer given with Keep, Enter or the save reads it. */
export const REPROCESS_DRAFT = "evaluation_reprocess";

/** A check's call that a reviewer can take over: the section's check and layer, with its run. */
interface ICheckCall {
	checkKey: AuditCheckKey;
	layer: AuditLayer;
	runId: number;
	verdict: AuditVerdict;
	labelId: number | null;
	/** the rule row's details: the dataset evaluation's fix flags and exclude reason */
	details: Record<string, unknown>;
}

/** Every decided call (not unsure) of the checks that ran on the dataset, in audit page order. */
function checkCalls(checks: IAuditChecks | undefined): ICheckCall[] {
	if (!checks) return [];
	return AUDIT_SECTIONS.flatMap(({ checkKey, layers }) => {
		const evidence = checkKey ? checks.checks[checkKey] : undefined;
		if (!checkKey || !evidence) return [];
		return layers.flatMap((layer) => {
			const verdict = automatedVerdict(evidence, layer);
			if (!verdict || verdict === "unsure") return [];
			const rule = automatedRows(evidence, layer)[0];
			return [{ checkKey, layer, runId: evidence.run.id, verdict, labelId: rule?.label_id ?? null, details: rule?.details ?? {} }];
		});
	});
}

/** The saved-audit fields a call fills: its verdict's field, and for a kept dataset the COG and
 * thumbnail flags the check named. */
function callFields(call: ICheckCall): Partial<AuditFormValues> {
	const values = formValuesForVerdict(call.checkKey, call.layer, call.verdict);
	if (call.checkKey === "dataset_evaluation" && keepsDataset(call.verdict)) {
		const flags = evaluationFlags({ details: call.details });
		for (const { flag, field } of EVALUATION_FLAGS) if (field) values[field] = flags.includes(flag);
	}
	return values;
}

/** Step 1's flags as the form holds them: the COG and thumbnail fields, and the reprocessing draft
 * (until it is touched, what the check said). */
export function evaluationDraft(values: Record<string, unknown>, ruleDetails: Record<string, unknown> | undefined): EvaluationFlag[] {
	const reprocess = values[REPROCESS_DRAFT];
	const ruleFlags = evaluationFlags({ details: ruleDetails ?? {} });
	return EVALUATION_FLAGS.filter((f) => (f.field ? values[f.field] === true : typeof reprocess === "boolean" ? reprocess : ruleFlags.includes(f.flag))).map(
		(f) => f.flag,
	);
}

/** The checks' calls as audit suggestions, so they prefill the form the way the stored
 * suggestions do: only fields the saved audit leaves empty, marked "suggested". A field a stored
 * suggestion already covers keeps that one. */
export function withCheckSuggestions(stored: IAuditSuggestion[], checks: IAuditChecks | undefined, datasetId: number): IAuditSuggestion[] {
	const covered = new Set(stored.map((s) => s.field));
	const fromChecks = checkCalls(checks).flatMap((call) =>
		Object.entries(callFields(call))
			.filter(([field]) => !covered.has(field))
			.map(([field, value]) => ({
				dataset_id: datasetId,
				field,
				value,
				source: "the automated check",
				reason: null,
				details: {},
				updated_at: "",
			})),
	);
	return fromChecks.length ? [...stored, ...fromChecks] : stored;
}

/** The verdict the saved form gives a call, or null when the form says nothing about it. */
function formVerdict(call: ICheckCall, values: Partial<AuditFormValues>): AuditVerdict | null {
	const fields = Object.entries(callFields(call));
	// the dataset evaluation's keep or exclude has no field: saving takes over the check's call
	if (call.checkKey === "dataset_evaluation") return call.verdict;
	if (!fields.length) return null;
	const [field, suggested] = fields[0];
	const saved = values[field as keyof AuditFormValues];
	if (saved === undefined || saved === null || saved === "") return null;
	if (saved === suggested) return call.verdict;
	// the reviewer changed the field: the answer is the verdict that field value stands for
	for (const verdict of ["ok", "minor", "major"] as const) {
		const implied = formValuesForVerdict(call.checkKey, call.layer, verdict)[field as keyof AuditFormValues];
		if (implied === saved) return verdict;
	}
	return null;
}

/** Saving the audit answers every call you have not answered yet: with the check's verdict where
 * the form still holds its suggestion, with your own where you changed the field. Each answer is
 * marked `with_save`, so it can be told apart from one you gave in its step. `only` limits it to
 * one check, e.g. the open step's when you accept it with Enter (`withSave: false`). */
export function answersWithSave(
	checks: IAuditChecks | undefined,
	userId: string | undefined,
	values: Partial<AuditFormValues> & Record<string, unknown>,
	datasetId: number,
	{ only, withSave = true }: { only?: AuditCheckKey; withSave?: boolean } = {},
): IAuditAnswerInput[] {
	if (!checks || !userId) return [];
	return checkCalls(checks).flatMap((call) => {
		if (only && call.checkKey !== only) return [];
		if (myAnswer(checks.people, userId, call.runId, { checkKey: call.checkKey, layer: call.layer })) return [];
		const verdict = formVerdict(call, values);
		if (!verdict) return [];
		const evaluation = call.checkKey === "dataset_evaluation";
		// a kept dataset's flags: COG and thumbnail as the form holds them, reprocessing as the check said
		const fixFlags = evaluation && keepsDataset(verdict) ? evaluationDraft(values, call.details) : [];
		return [
			{
				check_key: call.checkKey,
				dataset_id: datasetId,
				run_id: call.runId,
				layer: call.layer,
				label_id: call.labelId,
				verdict: evaluation && keepsDataset(verdict) ? (fixFlags.length ? "minor" : "ok") : verdict,
				reason_code: evaluation && !keepsDataset(verdict) && typeof call.details.reason === "string" ? call.details.reason : null,
				details: { ...(withSave ? { with_save: true } : {}), ...(evaluation ? { fix_flags: fixFlags } : {}) },
			},
		];
	});
}
