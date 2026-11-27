import { describe, expect, it } from "vitest";
import type { ITileJudgement } from "../types/auditChecks";
import { draftReview, savedLayer, suggestedLayer, withProblem, withVerdict } from "./cropAnswers";

const judgement = (over: Partial<ITileJudgement>): ITileJudgement => ({
	id: 1,
	run_id: 10,
	tile_id: 3,
	layer: "deadwood",
	judge: "luna",
	verdict: "minor",
	problems: null,
	summary: null,
	...over,
});

describe("draftReview: what a tile review stores", () => {
	it("keeps the verdict and tags the problems you saw true, the unsure ones unsure", () => {
		const review = draftReview({ verdict: "minor", problems: { m1_dead_missed: "yes", m4_dw_on_lying_wood: "unsure", m2_dw_on_live_vegetation: "no" } }, "deadwood");
		expect(review).toEqual({ verdict: "minor", problems: { m1_dead_missed: true, m4_dw_on_lying_wood: "unsure" } });
	});

	it("leaves out problems of the other layer", () => {
		expect(draftReview({ verdict: "ok", problems: { m5_fc_trees_missed: "yes" } }, "deadwood").problems).toEqual({});
	});
});

describe("suggestedLayer", () => {
	const models = [
		judgement({ problems: { m1_dead_missed: { likelihood: 80, area_pct: 12 }, m3_dw_on_non_vegetation: { likelihood: 20 } } }),
		judgement({ id: 2, judge: "haiku", verdict: "ok", problems: { m4_dw_on_lying_wood: { likelihood: 55 } } }),
		judgement({ id: 3, tile_id: 9, problems: { m2_dw_on_live_vegetation: { likelihood: 99 } } }),
	];

	it("starts from the call, with what a model saw (50 or more) ticked", () => {
		expect(suggestedLayer(models, 3, "deadwood", "major")).toEqual({ verdict: "major", problems: { m1_dead_missed: "yes", m4_dw_on_lying_wood: "yes" } });
		// the deciding model said minor without an error type likely enough to tick: still minor
		expect(suggestedLayer(models, 3, "forest_cover", "minor")).toEqual({ verdict: "minor", problems: {} });
		// an ok call means none of the error types
		expect(suggestedLayer(models, 3, "deadwood", "ok")).toEqual({ verdict: "ok", problems: {} });
		expect(suggestedLayer(models, 3, "deadwood", "ambiguous").verdict).toBe("ambiguous");
	});

	it("without a call: minor when a model saw a problem, ok when none saw one", () => {
		expect(suggestedLayer(models, 3, "deadwood", null).verdict).toBe("minor");
		expect(suggestedLayer(models, 3, "forest_cover", null)).toEqual({ verdict: "ok", problems: {} });
	});
});

describe("editing a layer answer", () => {
	it("reads a saved review back", () => {
		expect(savedLayer({ verdict: "major", problems: { m1_dead_missed: true, m7_dw_artifact: "unsure" } }, "deadwood")).toEqual({
			verdict: "major",
			problems: { m1_dead_missed: "yes", m7_dw_artifact: "unsure" },
		});
	});

	it("makes an ok tile minor when you see a problem, and ok clears the problems you saw", () => {
		const minor = withProblem({ verdict: "ok", problems: {} }, "m1_dead_missed", "yes");
		expect(minor).toEqual({ verdict: "minor", problems: { m1_dead_missed: "yes" } });
		expect(withVerdict({ ...minor, problems: { m1_dead_missed: "yes", m7_dw_artifact: "unsure" } }, "ok", "deadwood")).toEqual({
			verdict: "ok",
			problems: { m1_dead_missed: "no", m7_dw_artifact: "unsure" },
		});
	});

	it("puts every error type to unsure on an ambiguous tile and keeps yes or no off it", () => {
		const ambiguous = withVerdict({ verdict: "minor", problems: { m1_dead_missed: "yes" } }, "ambiguous", "deadwood");
		expect(ambiguous.verdict).toBe("ambiguous");
		expect(Object.values(ambiguous.problems).every((a) => a === "unsure")).toBe(true);
		expect(Object.keys(ambiguous.problems)).toContain("m1_dead_missed");
		expect(withProblem(ambiguous, "m1_dead_missed", "yes")).toBe(ambiguous);
		expect(withProblem(ambiguous, "m1_dead_missed", "unsure").problems.m1_dead_missed).toBe("unsure");
	});
});
