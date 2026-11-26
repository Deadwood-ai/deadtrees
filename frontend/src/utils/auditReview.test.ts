import { describe, expect, it } from "vitest";
import type { IAuditDatasetResult } from "../types/auditChecks";
import {
	decisionOfVerdict,
	evaluationAnswer,
	georefText,
	initialDraft,
	majorShare,
	openReviewItems,
	reviewAnswers,
	reviewRequiredText,
	sectionStatus,
	type IReviewContext,
} from "./auditReview";

const result = (over: Partial<IAuditDatasetResult> = {}): IAuditDatasetResult => ({
	dataset_id: 7,
	current_status: "idle",
	is_processing_done: true,
	evaluation_decision: "ok",
	evaluation_source: "check",
	cog_issue: false,
	thumbnail_issue: false,
	aoi_exists: true,
	aoi_created_at: "2026-11-01T10:00:00Z",
	aoi_source: "ml_prediction",
	aoi_model_version: "aoi_segmentation_v1",
	georef_status: "estimated",
	georef_offset_m: 4.2,
	georef_source: "check",
	date_replace: false,
	date_new: null,
	date_predicted: "2023-06-10",
	date_hdi80_days: 30,
	date_model_version: "doy_v2",
	date_estimated_at: "2026-11-02T10:00:00Z",
	date_source: "check",
	phenology_probability: 0.8,
	deadwood_total: 20,
	deadwood_major: 2,
	deadwood_minor: 3,
	deadwood_ok: 15,
	forest_cover_total: 20,
	forest_cover_major: 5,
	forest_cover_minor: 0,
	forest_cover_ok: 15,
	review_required: [],
	last_reviewed_at: null,
	in_benchmark: false,
	checks_run: ["dataset_evaluation", "georef", "acquisition_date", "prediction_quality"],
	...over,
});

const ctx = (over: Partial<IAuditDatasetResult> = {}, layers: IReviewContext["layers"] = {}): IReviewContext => ({
	datasetId: 7,
	result: result(over),
	runs: { dataset_evaluation: 11, georef: 12, acquisition_date: 13, prediction_quality: 14 },
	layers,
});

describe("what still needs a person", () => {
	it("keeps the view's order and drops what the page answered", () => {
		expect(openReviewItems(["evaluation", "georef", "aoi"], ["georef"])).toEqual(["evaluation", "aoi"]);
		expect(openReviewItems(null, [])).toEqual([]);
	});

	it("says so in one line", () => {
		expect(reviewRequiredText(["evaluation", "georef"])).toBe("Review required for Dataset evaluation, Georeferencing");
		expect(reviewRequiredText([])).toBe("No review required");
	});

	it("marks an open step and otherwise shows the check's output", () => {
		const r = result({ review_required: ["georef"], georef_status: "needs_review", georef_offset_m: 22 });
		expect(sectionStatus("georef", r, ["georef"]).label).toBe("Review required");
		expect(sectionStatus("georef", r, []).label).toBe("Needs review");
		expect(sectionStatus("evaluation", r, [])).toEqual({ label: "OK", tone: "ok" });
		expect(sectionStatus("deadwood", r, []).label).toBe("2 of 20 major");
		expect(sectionStatus("date", result({ date_replace: true }), []).label).toBe("Replace");
		expect(sectionStatus("phenology", result({ phenology_probability: 0.31 }), [])).toEqual({ label: "31%", tone: "warn" });
		expect(sectionStatus("aoi", undefined, []).label).toBe("Not run yet");
		expect(sectionStatus("georef", r, []).tone).toBe("warn");
		expect(sectionStatus("evaluation", result({ evaluation_decision: null }), []).label).toBe("Undecided");
		expect(sectionStatus("evaluation", result({ evaluation_decision: null, checks_run: [] }), []).label).toBe("Not run yet");
	});
});

describe("output words", () => {
	it("describes the georeferencing output", () => {
		expect(georefText(result())).toBe("4.2 m offset");
		expect(georefText(result({ georef_status: "needs_review", georef_offset_m: 22.4 }))).toBe("Needs review (best reference 22 m)");
		expect(georefText(result({ georef_status: "no_reference", georef_offset_m: null }))).toBe("No reference");
		expect(georefText(null)).toBe("Not run yet");
	});

	it("reads the decision of an evaluation verdict and the larger major crop share", () => {
		// an earlier "keep, fix" keeps the dataset
		expect(decisionOfVerdict("minor")).toBe("ok");
		expect(decisionOfVerdict("major")).toBe("exclude");
		expect(decisionOfVerdict("unsure")).toBeNull();
		expect(majorShare(result())).toBe(25);
		expect(majorShare(result({ deadwood_total: null, forest_cover_total: null }))).toBeNull();
	});
});

describe("Save: the person rows", () => {
	it("stores nothing for a step left as the view has it", () => {
		expect(reviewAnswers(initialDraft(result()), ctx())).toEqual({ answers: [], problems: [], answered: [] });
	});

	it("stores a changed decision with the COG and thumbnail flags as output, on the evaluation's run", () => {
		const draft = { ...initialDraft(result({ evaluation_decision: "exclude" })), decision: "ok" as const, cogIssue: true, evaluationNote: " reprocess the COG " };
		const { answers, problems, answered } = reviewAnswers(draft, ctx({ evaluation_decision: "exclude" }));
		expect(problems).toEqual([]);
		expect(answered).toEqual(["evaluation"]);
		expect(answers).toEqual([
			{
				check_key: "dataset_evaluation",
				dataset_id: 7,
				run_id: 11,
				layer: "image",
				verdict: "ok",
				reason_code: null,
				reason_text: "reprocess the COG",
				output: { cog_issue: true, thumbnail_issue: false },
			},
		]);
	});

	it("stores a flag changed under an unchanged decision", () => {
		const { answers } = reviewAnswers({ ...initialDraft(result()), thumbnailIssue: true }, ctx());
		expect(answers[0]).toMatchObject({ verdict: "ok", output: { cog_issue: false, thumbnail_issue: true } });
	});

	it("asks for the exclude reason", () => {
		expect(reviewAnswers({ ...initialDraft(result()), decision: "exclude" }, ctx()).problems).toEqual(["Pick why the dataset is excluded."]);
		const excluded = reviewAnswers({ ...initialDraft(result()), decision: "exclude", excludeReason: "blurry" }, ctx());
		expect(excluded.answers[0]).toMatchObject({ verdict: "major", reason_code: "blurry" });
	});

	it("stores the evaluation the check could not decide even when the draft was empty before", () => {
		const open = { review_required: ["evaluation" as const], evaluation_decision: null };
		expect(reviewAnswers(initialDraft(result(open)), ctx(open)).answers).toEqual([]);
		expect(reviewAnswers({ ...initialDraft(result(open)), decision: "ok" }, ctx(open)).answered).toEqual(["evaluation"]);
	});

	it("answers a georeferencing that needs review with its status and no verdict", () => {
		const open = { review_required: ["georef" as const], georef_status: "needs_review" as const };
		const { answers, answered } = reviewAnswers({ ...initialDraft(result(open)), georefStatus: "passed" }, ctx(open));
		expect(answered).toEqual(["georef"]);
		expect(answers).toEqual([{ check_key: "georef", dataset_id: 7, run_id: 12, layer: "georef", verdict: null, output: { status: "passed" }, reason_text: null }]);
	});

	it("keeps an earlier reviewer's georeferencing answer unless it changes or the step is open again", () => {
		const answeredBefore = { georef_status: "passed" as const, georef_source: "reviewer" as const };
		expect(initialDraft(result(answeredBefore)).georefStatus).toBe("passed");
		expect(reviewAnswers(initialDraft(result(answeredBefore)), ctx(answeredBefore)).answers).toEqual([]);
		const openAgain = { ...answeredBefore, review_required: ["georef" as const] };
		expect(reviewAnswers(initialDraft(result(openAgain)), ctx(openAgain)).answers).toHaveLength(1);
	});

	it("needs a note to override the date check", () => {
		const draft = { ...initialDraft(result()), dateReplace: true };
		expect(reviewAnswers(draft, ctx()).problems).toEqual(["Say in the note why the date check is overridden."]);
		const { answers } = reviewAnswers({ ...draft, dateNote: "the leaves say July" }, ctx());
		expect(answers).toEqual([
			{ check_key: "acquisition_date", dataset_id: 7, run_id: 13, layer: "acquisition_date", verdict: null, output: { replace: true }, reason_text: "the leaves say July" },
		]);
	});

	it("stores nothing for a prediction layer: it never needs review, and crop answers are stored at once", () => {
		const layer = { counts: { total: 20, major: 1, minor: 3, ok: 16 }, labelId: 55, crops: 20, answered: 20 };
		expect(reviewAnswers(initialDraft(result()), ctx({}, { deadwood: layer, forest_cover: layer }))).toEqual({ answers: [], problems: [], answered: [] });
	});

	it("builds the evaluation row the benchmark label stores too", () => {
		expect(evaluationAnswer({ decision: null }, ctx())).toBeNull();
		expect(evaluationAnswer({ decision: "exclude" }, ctx())?.problems).toEqual(["Pick why the dataset is excluded."]);
		expect(evaluationAnswer({ decision: "exclude", excludeReason: "blurry" }, ctx())).toEqual({
			row: expect.objectContaining({ check_key: "dataset_evaluation", run_id: 11, verdict: "major", reason_code: "blurry" }),
			problems: [],
		});
	});
});
