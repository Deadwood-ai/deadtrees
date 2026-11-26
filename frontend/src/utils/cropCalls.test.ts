import { describe, expect, it } from "vitest";
import type { IAuditAssessment, IAuditCheckEvidence } from "../types/auditChecks";
import { cropCall, cropFindings, layerCounts } from "./cropCalls";

const model = (crop_id: number, layer: IAuditAssessment["layer"], modelName: string, major_likelihood: number, verdict: IAuditAssessment["verdict"] = "ok") =>
	({ crop_id, layer, model: modelName, major_likelihood, verdict, assessor_kind: "model" }) as IAuditAssessment;

const run = { id: 1, check_key: "prediction_quality" as const, inputs: {}, evidence: {}, version: { config: { rule_config: {} } } };
const crop = (id: number, crop_sets: string[] = ["exclude"]) => ({ id, crop_sets, geometry: null, ortho_sha256: "x" }) as unknown as IAuditCheckEvidence["crops"][number];

const evidence = (automated: IAuditAssessment[]) => ({ run, automated, crops: [crop(1), crop(2), crop(3), crop(4, ["training"])] });

describe("cropCall", () => {
	it("is Haiku's verdict; Luna is shown, not counted", () => {
		const e = evidence([model(2, "deadwood", "luna-medium", 100, "major"), model(2, "deadwood", "haiku-5.5", 3), model(3, "deadwood", "haiku-5.5", 60, "major")]);
		expect(cropCall(e, 2, ["deadwood"])).toEqual({ verdict: "ok" });
		expect(cropCall(e, 3, ["deadwood"])).toEqual({ verdict: "major" });
	});

	it("has no call when Haiku could not assess the crop or gave no answer", () => {
		const e = evidence([model(1, "image", "haiku-5.5", 100, "major"), model(1, "deadwood", "haiku-5.5", 0), model(1, "deadwood", "luna-medium", 80, "major"), model(2, "deadwood", "luna-medium", 5)]);
		expect(cropCall(e, 1, ["deadwood"])).toEqual({ verdict: null });
		expect(cropCall(e, 2, ["deadwood"])).toEqual({ verdict: null });
		expect(cropCall(e, 5, ["deadwood"])).toEqual({ verdict: null });
	});

	it("follows the deciding model the version names, and takes the worst layer", () => {
		const e = { ...evidence([model(1, "deadwood", "luna-medium", 90, "major"), model(1, "deadwood", "haiku-5.5", 5, "ambiguous")]) };
		expect(cropCall(e, 1, ["deadwood"]).verdict).toBe("ambiguous");
		const luna = { ...e, run: { ...run, version: { config: { rule_config: { decider: "luna" } } } } };
		expect(cropCall(luna, 1, ["deadwood"]).verdict).toBe("major");
		const both = evidence([model(1, "forest_cover", "haiku-5.5", 60, "minor"), model(1, "deadwood", "haiku-5.5", 60, "major")]);
		expect(cropCall(both, 1, ["deadwood", "forest_cover"]).verdict).toBe("major");
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
			decides: false,
			verdict: "major",
			errors: ["Most dead crowns are unmarked."],
			issues: [{ key: "m1_dead_missed", label: "Dead trees missed", likelihood: 95, areaPct: 3 }],
		});
	});
});

describe("layerCounts", () => {
	const crops = [crop(1), crop(2), crop(3), crop(4, ["training"])];
	const calls = new Map([
		[1, { verdict: "major" as const }],
		[2, { verdict: "ok" as const }],
		[3, { verdict: "minor" as const }],
		[4, { verdict: null }],
	]);

	it("counts every judged crop with a call, your answers in place of the check's", () => {
		expect(layerCounts({ crops }, calls, () => null)).toEqual({ total: 3, major: 1, minor: 1, ok: 1, ambiguous: 0 });
		expect(layerCounts({ crops }, calls, (id) => (id === 3 ? "ok" : id === 4 ? "major" : null))).toEqual({ total: 4, major: 2, minor: 0, ok: 2, ambiguous: 0 });
		// "can't tell" keeps the check's call
		expect(layerCounts({ crops }, calls, (id) => (id === 1 ? "unsure" : null))).toEqual({ total: 3, major: 1, minor: 1, ok: 1, ambiguous: 0 });
	});

	it("counts your ambiguous crops apart, outside the total", () => {
		expect(layerCounts({ crops }, calls, (id) => (id === 1 ? "ambiguous" : null))).toEqual({ total: 2, major: 0, minor: 1, ok: 1, ambiguous: 1 });
	});
});
