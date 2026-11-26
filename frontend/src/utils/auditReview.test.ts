import { describe, expect, it } from "vitest";
import type { AuditCheckKey, IAuditDatasetResult, ITileCall } from "../types/auditChecks";
import {
	evaluationReview,
	georefText,
	initialDraft,
	layerProgress,
	majorShare,
	openReviewItems,
	reviewAnswers,
	reviewRequiredText,
	sectionStatus,
	withDraft,
} from "./auditReview";

const result = (over: Partial<IAuditDatasetResult> = {}): IAuditDatasetResult => ({
	dataset_id: 7,
	current_status: "idle",
	is_processing_done: true,
	evaluation_decision: "keep",
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
	in_benchmark: false,
	...over,
});

const RAN: AuditCheckKey[] = ["dataset_evaluation", "georef", "acquisition_date", "prediction_quality"];
const save = (draft: Parameters<typeof reviewAnswers>[0], over: Partial<IAuditDatasetResult> = {}) => reviewAnswers(draft, 7, result(over));

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
		expect(sectionStatus("georef", r, ["georef"], RAN).label).toBe("Review required");
		expect(sectionStatus("georef", r, [], RAN).label).toBe("Needs review");
		expect(sectionStatus("evaluation", r, [], RAN)).toEqual({ label: "OK", tone: "ok" });
		expect(sectionStatus("deadwood", r, [], RAN).label).toBe("2 of 20 major");
		expect(sectionStatus("date", result({ date_replace: true }), [], RAN).label).toBe("Replace");
		expect(sectionStatus("phenology", result({ phenology_probability: 0.31 }), [], RAN)).toEqual({ label: "31%", tone: "warn" });
		expect(sectionStatus("aoi", undefined, [], RAN).label).toBe("Not run yet");
		expect(sectionStatus("georef", r, [], RAN).tone).toBe("warn");
		expect(sectionStatus("evaluation", result({ evaluation_decision: null }), [], RAN).label).toBe("Undecided");
		expect(sectionStatus("evaluation", result({ evaluation_decision: null }), [], []).label).toBe("Not run yet");
	});
});

describe("output words", () => {
	it("describes the georeferencing output", () => {
		expect(georefText(result())).toBe("4.2 m offset");
		expect(georefText(result({ georef_status: "needs_review", georef_offset_m: 22.4 }))).toBe("Needs review (best reference 22 m)");
		expect(georefText(result({ georef_status: "no_reference", georef_offset_m: null }))).toBe("No reference");
		expect(georefText(null)).toBe("Not run yet");
	});

	it("reads the larger major crop share", () => {
		expect(majorShare(result())).toBe(25);
		expect(majorShare(result({ deadwood_total: null, forest_cover_total: null }))).toBeNull();
	});
});

describe("the draft", () => {
	it("starts from the outcome's decision", () => {
		expect(initialDraft(result()).decision).toBe("keep");
		expect(initialDraft(result({ evaluation_decision: "exclude" })).decision).toBe("exclude");
		expect(initialDraft(result({ evaluation_decision: null })).decision).toBeNull();
	});

	it("shows your decision in the step badge before Save", () => {
		expect(withDraft(result({ evaluation_decision: "exclude" }), { decision: "keep" }).evaluation_decision).toBe("keep");
	});
});

describe("Save: the dataset reviews", () => {
	it("stores nothing for a step left as the view has it", () => {
		expect(save(initialDraft(result()))).toEqual({ reviews: [], problems: [], answered: [] });
	});

	it("stores a changed decision with the COG and thumbnail issues", () => {
		const draft = { ...initialDraft(result({ evaluation_decision: "exclude" })), decision: "keep" as const, cogIssue: true, evaluationNote: " reprocess the COG " };
		const { reviews, problems, answered } = save(draft, { evaluation_decision: "exclude" });
		expect(problems).toEqual([]);
		expect(answered).toEqual(["evaluation"]);
		expect(reviews).toEqual([
			{
				dataset_id: 7,
				check_key: "dataset_evaluation",
				decision: "keep",
				exclude_reason: null,
				cog_issue: true,
				thumbnail_issue: false,
				note: "reprocess the COG",
			},
		]);
	});

	it("stores an issue changed under an unchanged decision", () => {
		const { reviews } = save({ ...initialDraft(result()), thumbnailIssue: true });
		expect(reviews[0]).toMatchObject({ decision: "keep", cog_issue: false, thumbnail_issue: true });
	});

	it("asks for the exclude reason", () => {
		expect(save({ ...initialDraft(result()), decision: "exclude" }).problems).toEqual(["Pick why the dataset is excluded."]);
		const excluded = save({ ...initialDraft(result()), decision: "exclude", excludeReason: "blurry" });
		expect(excluded.reviews[0]).toMatchObject({ decision: "exclude", exclude_reason: "blurry" });
	});

	it("stores the evaluation the check could not decide even when the draft was empty before", () => {
		const open = { review_required: ["evaluation" as const], evaluation_decision: null };
		expect(save(initialDraft(result(open)), open).reviews).toEqual([]);
		expect(save({ ...initialDraft(result(open)), decision: "keep" }, open).answered).toEqual(["evaluation"]);
	});

	it("answers a georeferencing that needs review with its status", () => {
		const open = { review_required: ["georef" as const], georef_status: "needs_review" as const };
		const { reviews, answered } = save({ ...initialDraft(result(open)), georefStatus: "passed" }, open);
		expect(answered).toEqual(["georef"]);
		expect(reviews).toEqual([{ dataset_id: 7, check_key: "georef", georef_status: "passed", note: null }]);
	});

	it("keeps an earlier reviewer's georeferencing answer unless it changes or the step is open again", () => {
		const answeredBefore = { georef_status: "passed" as const, georef_source: "reviewer" as const };
		expect(initialDraft(result(answeredBefore)).georefStatus).toBe("passed");
		expect(save(initialDraft(result(answeredBefore)), answeredBefore).reviews).toEqual([]);
		const openAgain = { ...answeredBefore, review_required: ["georef" as const] };
		expect(save(initialDraft(result(openAgain)), openAgain).reviews).toHaveLength(1);
	});

	it("needs a note to override the date check", () => {
		const draft = { ...initialDraft(result()), dateReplace: true };
		expect(save(draft).problems).toEqual(["Say in the note why the date check is overridden."]);
		const { reviews } = save({ ...draft, dateNote: "the leaves say July" });
		expect(reviews).toEqual([{ dataset_id: 7, check_key: "acquisition_date", date_replace: true, note: "the leaves say July" }]);
	});

	it("builds the evaluation review the benchmark label stores too", () => {
		expect(evaluationReview({ decision: null }, 7)).toBeNull();
		expect(evaluationReview({ decision: "exclude" }, 7)?.problems).toEqual(["Pick why the dataset is excluded."]);
		expect(evaluationReview({ decision: "exclude", excludeReason: "blurry" }, 7)).toEqual({
			review: expect.objectContaining({ check_key: "dataset_evaluation", decision: "exclude", exclude_reason: "blurry" }),
			problems: [],
		});
	});
});

describe("a prediction layer's progress", () => {
	const call = (tile_id: number, over: Partial<ITileCall> = {}): ITileCall => ({
		dataset_id: 7,
		run_id: 14,
		tile_id,
		layer: "deadwood",
		prediction_label_id: 55,
		verdict: "ok",
		by_person: false,
		review_id: null,
		judgement_id: null,
		...over,
	});

	it("counts the tiles a person answered and the ambiguous ones, per layer", () => {
		const calls = [call(1), call(2, { by_person: true, verdict: "ambiguous", review_id: 9 }), call(3, { layer: "forest_cover" })];
		expect(layerProgress(calls, "deadwood")).toEqual({ crops: 2, answered: 1, ambiguous: 1 });
		expect(layerProgress([], "deadwood")).toBeNull();
	});
});
