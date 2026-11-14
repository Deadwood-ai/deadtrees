import { describe, expect, it } from "vitest";
import type { IAuditAssessment, IAuditCheckEvidence } from "../types/auditChecks";
import { cropCall, cropCalls, cropFindings, cropsForReview, layerRatingFromCrops } from "./cropCalls";

const model = (crop_id: number, layer: IAuditAssessment["layer"], modelName: string, major_likelihood: number, verdict: IAuditAssessment["verdict"] = "ok") =>
	({ crop_id, layer, model: modelName, major_likelihood, verdict, assessor_kind: "model" }) as IAuditAssessment;

const run = { id: 1, check_key: "prediction_quality" as const, inputs: {}, evidence: {}, version: { config: { rule_config: { crop_major_cut: { deadwood: 52, forest: 69 } } } } };
const crop = (id: number, crop_sets: string[] = ["exclude"]) => ({ id, crop_sets, geometry: null, ortho_sha256: "x" }) as unknown as IAuditCheckEvidence["crops"][number];

const evidence = (automated: IAuditAssessment[]) => ({ run, automated, crops: [crop(1), crop(2), crop(3), crop(4, ["training"])] });

describe("cropCall", () => {
	it("counts a crop major when the models' mean likelihood reaches the version's cut-off, as the rule does", () => {
		const e = evidence([model(2, "deadwood", "a", 100, "major"), model(2, "deadwood", "b", 3), model(3, "deadwood", "a", 60, "major"), model(3, "deadwood", "b", 50, "minor")]);
		// 51.5 is below 52: one model alone saying major does not make the crop major
		expect(cropCall(e, 2, ["deadwood"])).toBe("ok");
		expect(cropCall(e, 3, ["deadwood"])).toBe("major");
	});

	it("leaves out a model that could not assess the crop", () => {
		const e = evidence([model(1, "image", "a", 100, "major"), model(1, "deadwood", "a", 0), model(1, "deadwood", "b", 80, "major")]);
		expect(cropCall(e, 1, ["deadwood"])).toBe("major");
	});

	it("uses each layer's own cut-off and is major when any layer is", () => {
		const e = evidence([model(1, "forest_cover", "a", 60, "major"), model(1, "deadwood", "a", 60, "major")]);
		expect(cropCall(e, 1, ["forest_cover"])).toBe("ok");
		expect(cropCall(e, 1, ["deadwood", "forest_cover"])).toBe("major");
	});

	it("says nothing without cut-offs", () => {
		const e = { ...evidence([model(1, "deadwood", "a", 90, "major")]), run: { ...run, version: null } };
		expect(cropCall(e, 1, ["deadwood"])).toBeNull();
	});
});

describe("cropsForReview", () => {
	it("puts the crops the check counted major first and lists them", () => {
		const e = evidence([model(3, "deadwood", "a", 90, "major"), model(1, "deadwood", "a", 10)]);
		const calls = cropCalls(e, ["deadwood"]);
		expect(cropsForReview(e, calls).map((c) => c.id)).toEqual([3, 1, 2, 4]);
		expect([...calls].filter(([, call]) => call === "major").map(([id]) => id)).toEqual([3]);
	});
});

describe("cropFindings", () => {
	it("says what each model saw in a crop: its likely error types with their share, and its words", () => {
		const row = {
			crop_id: 7,
			layer: "deadwood",
			model: "luna-medium",
			assessor_kind: "model",
			verdict: "major",
			major_likelihood: 95,
			modes: { m1_dead_missed: { likelihood: 95, area_pct: 3 }, m4_dw_on_lying_wood: { likelihood: 40, area_pct: 1 }, m0_not_assessable: { likelihood: 0 } },
			details: { errors: ["Most dead crowns are unmarked."] },
		} as unknown as IAuditAssessment;
		const [finding] = cropFindings({ automated: [row] }, 7, "deadwood");
		expect(finding).toEqual({
			model: "Luna",
			verdict: "major",
			errors: ["Most dead crowns are unmarked."],
			issues: [{ key: "m1_dead_missed", label: "Dead trees missed", likelihood: 95, areaPct: 3 }],
		});
	});
});

describe("layerRatingFromCrops", () => {
	const crops = [crop(1), crop(2), crop(3), crop(4, ["training"])];
	const calls = new Map<number, IAuditAssessment["verdict"] | null>([[1, "major"], [2, "ok"], [3, "ok"], [4, "major"]]);

	it("counts the check's calls on the exclude set, and your answers over them", () => {
		expect(layerRatingFromCrops({ crops }, calls, () => null)).toEqual({ quality: "sentinel_ok", major: 1, counted: 3 });
		expect(layerRatingFromCrops({ crops }, calls, (id) => (id === 2 ? "major" : null))).toEqual({ quality: "bad", major: 2, counted: 3 });
		expect(layerRatingFromCrops({ crops }, calls, (id) => (id === 1 ? "ok" : null))).toEqual({ quality: "great", major: 0, counted: 3 });
	});
});
