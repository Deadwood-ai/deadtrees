import { describe, expect, it } from "vitest";
import type { IAuditSuggestion } from "../types/acquisitionDate";
import type { IAuditAssessment, IAuditCheckEvidence, IAuditChecks, IAuditQueueRow } from "../types/auditChecks";
import { REPROCESS_DRAFT, answersWithSave, evaluationDraft, withCheckSuggestions } from "./auditPrefill";

const rule = (overrides: Partial<IAuditAssessment>): IAuditAssessment => ({
	id: 1,
	check_key: "georef",
	dataset_id: 7,
	crop_id: null,
	run_id: 10,
	layer: "georef",
	label_id: null,
	assessor_kind: "rule",
	assessor_user_id: null,
	model: null,
	prompt_version: null,
	assessor: "rule",
	verdict: "ok",
	reason_code: null,
	reason_text: null,
	details: {},
	...overrides,
});

const queue = (overrides: Partial<IAuditQueueRow>): IAuditQueueRow => ({
	dataset_id: 7,
	check_key: "georef",
	layer: "georef",
	run_id: 10,
	verdict: "ok",
	reason: "review_all",
	...overrides,
});

const evidence = (checkKey: IAuditQueueRow["check_key"], runId: number, rows: Partial<IAuditAssessment>[]): IAuditCheckEvidence => ({
	run: { id: runId, check_key: checkKey, inputs: {}, evidence: {} },
	automated: rows.map((r) => rule({ check_key: checkKey, run_id: runId, ...r })),
	queue: rows.map((r) => queue({ check_key: checkKey, run_id: runId, layer: r.layer!, verdict: r.verdict! })),
	crops: [],
	images: [],
});

const checks = (people: IAuditAssessment[] = []): IAuditChecks => ({
	available: true,
	checks: {
		dataset_evaluation: evidence("dataset_evaluation", 1, [{ layer: "image", verdict: "minor", details: { fix_flags: ["cog_issue"] } }]),
		georef: evidence("georef", 2, [{ layer: "georef", verdict: "major" }]),
		prediction_quality: evidence("prediction_quality", 3, [
			{ layer: "deadwood", verdict: "minor", label_id: 55 },
			{ layer: "forest_cover", verdict: "unsure", label_id: 56 },
		]),
	},
	people,
});

describe("withCheckSuggestions", () => {
	it("turns the checks' decided calls into suggestions for the audit fields", () => {
		const fields = Object.fromEntries(withCheckSuggestions([], checks(), 7).map((s) => [s.field, s.value]));
		expect(fields).toEqual({
			has_cog_issue: true,
			has_thumbnail_issue: false,
			is_georeferenced: false,
			deadwood_quality: "sentinel_ok",
		});
	});

	it("keeps a stored suggestion for the same field", () => {
		const stored = [{ field: "is_georeferenced", value: true, source: "georef check" } as IAuditSuggestion];
		const merged = withCheckSuggestions(stored, checks(), 7);
		expect(merged.filter((s) => s.field === "is_georeferenced")).toEqual(stored);
	});
});

describe("answersWithSave", () => {
	const untouched = { has_cog_issue: true, has_thumbnail_issue: false, is_georeferenced: false, deadwood_quality: "sentinel_ok" as const };

	it("answers each call you left as suggested with the check's verdict, marked as given with the save", () => {
		const answers = answersWithSave(checks(), "me", untouched, 7);
		expect(answers.map((a) => [a.check_key, a.layer, a.verdict])).toEqual([
			["dataset_evaluation", "image", "minor"],
			["georef", "georef", "major"],
			["prediction_quality", "deadwood", "minor"],
		]);
		expect(answers[0].details).toEqual({ with_save: true, fix_flags: ["cog_issue"] });
		expect(answers[2]).toMatchObject({ run_id: 3, label_id: 55, details: { with_save: true } });
	});

	it("takes your value where you changed a field", () => {
		const answers = answersWithSave(checks(), "me", { ...untouched, has_cog_issue: false, is_georeferenced: true, deadwood_quality: "bad" }, 7);
		expect(answers.map((a) => a.verdict)).toEqual(["ok", "ok", "major"]);
		expect(answers[0].details).toEqual({ with_save: true, fix_flags: [] });
	});

	it("skips calls you already answered and fields the form leaves empty", () => {
		const mine = rule({ assessor_kind: "person", assessor_user_id: "me", assessor: "me", check_key: "georef", run_id: 2, verdict: "ok" });
		const answers = answersWithSave(checks([mine]), "me", { has_cog_issue: true }, 7);
		expect(answers.map((a) => a.check_key)).toEqual(["dataset_evaluation"]);
	});
});

describe("answersWithSave for one step", () => {
	it("answers only the given check, unmarked when not given with the save", () => {
		const answers = answersWithSave(checks(), "me", { is_georeferenced: false }, 7, { only: "georef", withSave: false });
		expect(answers).toHaveLength(1);
		expect(answers[0]).toMatchObject({ check_key: "georef", verdict: "major", details: {} });
	});
});

describe("step 1 draft", () => {
	it("reads the COG and thumbnail fields and the reprocessing draft, falling back to the check for reprocessing", () => {
		expect(evaluationDraft({ has_cog_issue: true, has_thumbnail_issue: false }, { fix_flags: ["reprocess"] })).toEqual(["cog_issue", "reprocess"]);
		expect(evaluationDraft({ has_cog_issue: false, [REPROCESS_DRAFT]: false }, { fix_flags: ["reprocess"] })).toEqual([]);
	});

	it("stores the flags the reviewer set before accepting, including reprocessing", () => {
		const answers = answersWithSave(checks(), "me", { has_cog_issue: false, has_thumbnail_issue: true, [REPROCESS_DRAFT]: true }, 7, {
			only: "dataset_evaluation",
			withSave: false,
		});
		expect(answers[0]).toMatchObject({ verdict: "minor", details: { fix_flags: ["thumbnail_issue", "reprocess"] } });
	});
});
