import { describe, expect, it } from "vitest";
import type { IAuditAssessment } from "../types/auditChecks";
import { evaluationAnswerRow, targetKey, targetNoun, latestLabel, latestLabelRow, nextOpen, sameBenchmark, stratified } from "./benchmarkLabels";

const person = (user: string, overrides: Partial<IAuditAssessment>): IAuditAssessment => ({
	id: 1,
	check_key: "prediction_quality",
	dataset_id: 7,
	crop_id: 70,
	run_id: null,
	layer: "deadwood",
	label_id: 11,
	assessor_kind: "person",
	assessor_user_id: user,
	model: null,
	prompt_version: null,
	assessor: user,
	verdict: "ok",
	modes: {},
	reason_code: null,
	reason_text: null,
	details: {},
	...overrides,
});

describe("a target's label", () => {
	it("is the latest answer per layer, whoever gave it", () => {
		const rows = [
			person("a", { id: 1, layer: "image" }),
			person("a", { id: 2, verdict: "major" }),
			person("b", { id: 3, verdict: "minor" }),
		];
		const label = latestLabel(rows);
		expect(label.map((r) => [r.layer, r.verdict, r.assessor])).toEqual([
			["image", "ok", "a"],
			["deadwood", "minor", "b"],
		]);
		expect(latestLabelRow({ people: label })?.id).toBe(3);
		expect(latestLabelRow({ people: [] })).toBeNull();
	});
});

describe("stepping through a benchmark", () => {
	const targets = [1, 2, 3].map((id) => ({ id, people: id === 2 ? [person("me", {})] : [] }));

	it("names a target in the URL by its crop or dataset, and calls them tiles or datasets", () => {
		expect(targetKey({ dataset_id: 7, crop_id: 70 })).toBe("crop-70");
		expect(targetKey({ dataset_id: 7, crop_id: null })).toBe("dataset-7");
		expect(targetNoun({ check_key: "prediction_quality", layer: "deadwood" })).toBe("tiles");
		expect(targetNoun({ check_key: "dataset_evaluation", layer: null }, 1)).toBe("dataset");
	});

	it("goes to the next target without a label, wrapping, and stops when none is left", () => {
		expect(nextOpen(targets, 1)?.id).toBe(3);
		expect(nextOpen(targets, 3)?.id).toBe(1);
		expect(nextOpen([targets[1], targets[0]], 1)).toBeNull();
	});
});

describe("stratified order", () => {
	it("takes one target per dataset in turn", () => {
		const t = (id: number, dataset_id: number) => ({ id, dataset_id });
		expect(stratified([t(1, 5), t(2, 5), t(3, 5), t(4, 6), t(5, 7), t(6, 7)]).map((x) => x.id)).toEqual([1, 4, 5, 2, 6, 3]);
		expect(stratified([])).toEqual([]);
	});
});

describe("dataset evaluation labels", () => {
	it("stores OK with its issues, with the run that judged the dataset; an earlier keep, fix is OK", () => {
		expect(evaluationAnswerRow({ verdict: "ok", reason: null, flags: ["cog_issue"], note: "" }, 5, 41)).toEqual({
			row: expect.objectContaining({ verdict: "ok", reason_code: null, details: { fix_flags: ["cog_issue"] }, run_id: 41, crop_id: null, layer: "image" }),
		});
		expect(evaluationAnswerRow({ verdict: "minor", reason: null, flags: [], note: "" }, 5, 41)).toEqual({ row: expect.objectContaining({ verdict: "ok" }) });
	});

	it("needs a call, and a reason to exclude", () => {
		expect(evaluationAnswerRow({ verdict: null, reason: null, flags: [], note: "" }, 5, null)).toEqual({ missing: expect.any(String) });
		expect(evaluationAnswerRow({ verdict: "major", reason: null, flags: [], note: "" }, 5, null)).toEqual({ missing: "Excluding needs a reason" });
		expect(evaluationAnswerRow({ verdict: "major", reason: "blurry", flags: [], note: " soft " }, 5, null)).toEqual({
			row: expect.objectContaining({ verdict: "major", reason_code: "blurry", reason_text: "soft", details: { fix_flags: [] }, run_id: null }),
		});
	});
});

describe("which benchmark", () => {
	it("tells the layers of prediction quality apart", () => {
		const deadwood = { check_key: "prediction_quality", layer: "deadwood" } as const;
		expect(sameBenchmark(deadwood, { check_key: "prediction_quality", layer: "deadwood" })).toBe(true);
		expect(sameBenchmark(deadwood, { check_key: "prediction_quality", layer: "forest_cover" })).toBe(false);
		expect(sameBenchmark({ check_key: "dataset_evaluation", layer: null }, { check_key: "dataset_evaluation", layer: null })).toBe(true);
	});
});
