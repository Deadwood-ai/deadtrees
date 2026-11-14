import { describe, expect, it } from "vitest";
import type { IAuditAssessment } from "../types/auditChecks";
import { agreement, cropVerdicts, evaluationAnswerRow, filterTargets, labelersDisagree, nextOpen } from "./benchmarkLabels";

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

describe("labelers", () => {
	it("reads a crop answer as can't tell or a verdict per layer", () => {
		expect(cropVerdicts([person("a", { layer: "image", verdict: "major" }), person("a", {})])).toBe("cant_tell");
		expect(cropVerdicts([person("a", { layer: "image" }), person("a", { verdict: "minor" }), person("a", { layer: "forest_cover" })])).toEqual({
			deadwood: "minor",
			forest_cover: "ok",
		});
	});

	it("finds labelers who disagree on a layer verdict or the image gate", () => {
		const a = [person("a", { layer: "image" }), person("a", { verdict: "major" })];
		const b = [person("b", { layer: "image" }), person("b", { verdict: "major" })];
		expect(labelersDisagree("prediction_quality", [...a, ...b])).toBe(false);
		expect(labelersDisagree("prediction_quality", [...a, person("c", { layer: "image", verdict: "major" })])).toBe(true);
		expect(labelersDisagree("prediction_quality", a)).toBe(false);
		const keep = person("a", { check_key: "dataset_evaluation", layer: "image", crop_id: null, verdict: "minor" });
		expect(labelersDisagree("dataset_evaluation", [keep, { ...keep, assessor_user_id: "b", assessor: "b", verdict: "ok" }])).toBe(false);
		expect(labelersDisagree("dataset_evaluation", [keep, { ...keep, assessor_user_id: "b", assessor: "b", verdict: "major" }])).toBe(true);
	});

	it("marks who found a problem the other did not", () => {
		expect(agreement("ok", "major")).toBe("they_flag");
		expect(agreement("major", "ok")).toBe("you_flag");
		expect(agreement("minor", "minor")).toBe("agree");
		expect(agreement("minor", "major")).toBe("other");
		expect(agreement(null, "major")).toBeNull();
	});
});

describe("stepping through a benchmark", () => {
	const targets = [1, 2, 3].map((id) => ({ id, people: id === 2 ? [person("me", {})] : [] }));

	it("keeps a target answered in this visit in the open list", () => {
		expect(filterTargets(targets, "open", "prediction_quality", "me").map((t) => t.id)).toEqual([1, 3]);
		expect(filterTargets(targets, "open", "prediction_quality", "me", new Set([2])).map((t) => t.id)).toEqual([1, 2, 3]);
		expect(filterTargets(targets, "all", "prediction_quality", "me")).toHaveLength(3);
	});

	it("goes to the next target without your answer, wrapping, and stops when none is left", () => {
		expect(nextOpen(targets, 1, "me")?.id).toBe(3);
		expect(nextOpen(targets, 3, "me")?.id).toBe(1);
		expect(nextOpen([targets[1], targets[0]], 1, "me")).toBeNull();
	});
});

describe("dataset evaluation labels", () => {
	it("stores keep with a fix flag as keep, fix, with the run that judged the dataset", () => {
		expect(evaluationAnswerRow({ verdict: "ok", reason: null, flags: ["cog_issue"], note: "" }, 5, 41)).toEqual({
			row: expect.objectContaining({ verdict: "minor", reason_code: null, details: { fix_flags: ["cog_issue"] }, run_id: 41, crop_id: null, layer: "image" }),
		});
	});

	it("needs a call, and a reason to exclude", () => {
		expect(evaluationAnswerRow({ verdict: null, reason: null, flags: [], note: "" }, 5, null)).toEqual({ missing: expect.any(String) });
		expect(evaluationAnswerRow({ verdict: "major", reason: null, flags: [], note: "" }, 5, null)).toEqual({ missing: "Excluding needs a reason" });
		expect(evaluationAnswerRow({ verdict: "major", reason: "blurry", flags: [], note: " soft " }, 5, null)).toEqual({
			row: expect.objectContaining({ verdict: "major", reason_code: "blurry", reason_text: "soft", details: { fix_flags: [] }, run_id: null }),
		});
	});
});
