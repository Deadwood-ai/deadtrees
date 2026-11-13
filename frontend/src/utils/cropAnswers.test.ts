import { describe, expect, it } from "vitest";
import type { IAuditAssessment } from "../types/auditChecks";
import { answeredValues, cropAnswerRows, myCropVerdict, savedLayer, suggestedLayer, withProblem, withVerdict } from "./cropAnswers";

const row = (overrides: Partial<IAuditAssessment>): IAuditAssessment =>
	({
		id: 1,
		check_key: "prediction_quality",
		dataset_id: 7,
		crop_id: 3,
		run_id: 10,
		layer: "deadwood",
		label_id: null,
		assessor_kind: "model",
		assessor_user_id: null,
		model: "luna",
		prompt_version: null,
		assessor: "luna",
		verdict: "minor",
		reason_code: null,
		reason_text: null,
		details: {},
		...overrides,
	}) as IAuditAssessment;

describe("cropAnswerRows: the gold rows' format", () => {
	it("stores an image row, then the layer with the problems you saw tagged and the unsure ones in details", () => {
		const rows = cropAnswerRows({
			assessable: true,
			layers: { deadwood: { verdict: "minor", problems: { m1_dead_missed: "yes", m4_dw_on_lying_wood: "unsure", m2_dw_on_live_vegetation: "no" } } },
		});
		expect(rows).toEqual([
			{ layer: "image", verdict: "ok", modes: {} },
			{ layer: "deadwood", verdict: "minor", modes: { m1_dead_missed: true }, details: { unsure_modes: ["m4_dw_on_lying_wood"] } },
		]);
	});

	it("stores can't tell as the image row only: major, tagged not assessable", () => {
		expect(cropAnswerRows({ assessable: false })).toEqual([{ layer: "image", verdict: "major", modes: { m0_not_assessable: true } }]);
	});
});

describe("suggestedLayer", () => {
	const models = [
		row({ modes: { m1_dead_missed: { likelihood: 80, area_pct: 12 }, m3_dw_on_non_vegetation: { likelihood: 20 } } }),
		row({ id: 2, model: "haiku", verdict: "ok", modes: { m4_dw_on_lying_wood: { likelihood: 55 } } }),
		row({ id: 3, crop_id: 9, modes: { m2_dw_on_live_vegetation: { likelihood: 99 } } }),
	];

	it("ticks what a model saw (50 or more) and takes major from the check", () => {
		expect(suggestedLayer(models, 3, "deadwood", true)).toEqual({ verdict: "major", problems: { m1_dead_missed: "yes", m4_dw_on_lying_wood: "yes" } });
	});

	it("is minor when a model saw a problem the check did not count major, ok when none saw one", () => {
		expect(suggestedLayer(models, 3, "deadwood", false).verdict).toBe("minor");
		expect(suggestedLayer(models, 3, "forest_cover", false)).toEqual({ verdict: "ok", problems: {} });
	});
});

describe("editing a layer answer", () => {
	it("reads a saved row back", () => {
		const saved = row({ assessor_kind: "person", verdict: "major", modes: { m1_dead_missed: true }, details: { unsure_modes: ["m7_dw_artifact"] } });
		expect(savedLayer(saved)).toEqual({ verdict: "major", problems: { m1_dead_missed: "yes", m7_dw_artifact: "unsure" } });
	});

	it("makes an ok crop minor when you see a problem, and ok clears the problems you saw", () => {
		const minor = withProblem({ verdict: "ok", problems: {} }, "m1_dead_missed", "yes");
		expect(minor).toEqual({ verdict: "minor", problems: { m1_dead_missed: "yes" } });
		expect(withVerdict({ ...minor, problems: { m1_dead_missed: "yes", m7_dw_artifact: "unsure" } }, "ok")).toEqual({
			verdict: "ok",
			problems: { m1_dead_missed: "no", m7_dw_artifact: "unsure" },
		});
	});
});

describe("myCropVerdict", () => {
	const person = (layer: IAuditAssessment["layer"], verdict: IAuditAssessment["verdict"], crop_id = 3) =>
		row({ assessor_kind: "person", assessor_user_id: "me", model: null, layer, verdict, crop_id });

	it("gives your layer verdict, and unsure (not counted) when you can't tell what the crop shows", () => {
		const mine = myCropVerdict([person("deadwood", "major"), person("image", "major", 4), person("deadwood", "ok", 4)], "me", 10, "deadwood");
		expect(mine(3)).toBe("major");
		expect(mine(4)).toBe("unsure");
		expect(mine(5)).toBeNull();
	});
});

describe("answeredValues", () => {
	const person = (layer: IAuditAssessment["layer"], verdict: IAuditAssessment["verdict"], crop_id: number | null) =>
		row({ assessor_kind: "person", assessor_user_id: "me", model: null, layer, verdict, crop_id });
	const crop = (id: number) => ({ id, ortho_sha256: "x", crop_sets: ["exclude"], geometry: { type: "Polygon" as const, coordinates: [] } });
	const checks = (people: IAuditAssessment[]) => ({
		available: true,
		checks: { prediction_quality: { run: { id: 10, check_key: "prediction_quality" as const, inputs: {}, evidence: {} }, automated: [], queue: [], crops: [crop(1), crop(2), crop(3)], images: [] } },
		people,
	});

	it("sets an answered prediction layer to the rating from your crop answers, not an older layer answer", () => {
		const people = [person("deadwood", "minor", null), person("deadwood", "major", 1), person("deadwood", "major", 2)];
		expect(answeredValues(checks(people), "me").deadwood_quality).toBe("bad");
	});

	it("leaves a layer you have not answered to the suggestions", () => {
		expect(answeredValues(checks([]), "me").deadwood_quality).toBeUndefined();
	});
});
