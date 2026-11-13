import { describe, expect, it } from "vitest";
import type { IAuditAssessment } from "../types/auditChecks";
import {
	QUESTIONS,
	agreement,
	answerQuestion,
	cropAnswerRows,
	draftFromRows,
	emptyDraft,
	evaluationAnswerRow,
	filterTargets,
	labelersDisagree,
	layerFine,
	nextOpen,
	problemAnswer,
	setVerdict,
	wholeCropFine,
} from "./benchmarkLabels";

const target = { datasetId: 7, cropId: 70, labelIds: { deadwood: 11, forest_cover: 12 } };
const question = (mode: string | null, layer: "deadwood" | "forest_cover" = "deadwood") => QUESTIONS.find((q) => q.layer === layer && q.mode === mode)!;

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

describe("crop labels", () => {
	it("stores a whole fine crop as an assessable image row and OK on both layers, with the overlays' predictions", () => {
		const result = cropAnswerRows(wholeCropFine(emptyDraft()), target);
		expect("rows" in result && result.rows.map((r) => [r.layer, r.verdict, r.label_id ?? null, r.modes, r.run_id])).toEqual([
			["image", "ok", null, {}, null],
			["deadwood", "ok", 11, {}, null],
			["forest_cover", "ok", 12, {}, null],
		]);
	});

	it("counts unanswered problems as no, and needs minor or major once a problem is marked", () => {
		let draft = answerQuestion(emptyDraft(), question("m1_dead_missed"), "yes");
		draft = answerQuestion(draft, question("m4_dw_on_lying_wood"), "unsure");
		expect(cropAnswerRows(draft, target)).toEqual({ missing: expect.stringContaining("Deadwood") });
		draft = setVerdict(draft, "deadwood", "major");
		const result = cropAnswerRows(draft, target, " blurry corner ");
		expect("rows" in result && result.rows).toEqual([
			expect.objectContaining({ layer: "image", verdict: "ok", details: { note: "blurry corner" } }),
			expect.objectContaining({ layer: "deadwood", verdict: "major", modes: { m1_dead_missed: true }, details: { unsure_modes: ["m4_dw_on_lying_wood"] } }),
			expect.objectContaining({ layer: "forest_cover", verdict: "ok", modes: {} }),
		]);
	});

	it("stores can't tell as one image row, as the gold rows do", () => {
		const result = cropAnswerRows({ ...emptyDraft(), cantTell: true }, target);
		expect("rows" in result && result.rows).toEqual([
			expect.objectContaining({ layer: "image", verdict: "major", modes: { m0_not_assessable: true }, crop_id: 70 }),
		]);
	});

	it("reads a stored answer back as the same draft", () => {
		const draft = setVerdict(answerQuestion(layerFine(emptyDraft(), "forest_cover"), question("m2_dw_on_live_vegetation"), "yes"), "deadwood", "minor");
		const result = cropAnswerRows(draft, target);
		const rows = "rows" in result ? result.rows.map((r, i) => person("me", { ...r, id: i, modes: r.modes as IAuditAssessment["modes"], details: r.details ?? {} })) : [];
		const back = draftFromRows(rows)!;
		expect(back.layers.deadwood.verdict).toBe("minor");
		expect(back.layers.deadwood.modes.m2_dw_on_live_vegetation).toBe("yes");
		expect(back.layers.deadwood.modes.m1_dead_missed).toBe("no");
		expect(back.layers.forest_cover).toEqual(draft.layers.forest_cover);
	});

	it("answers unsure on a verdict row and ignores yes and no there", () => {
		const verdictRow = question(null);
		expect(answerQuestion(emptyDraft(), verdictRow, "yes")).toEqual(emptyDraft());
		expect(answerQuestion(emptyDraft(), verdictRow, "unsure").layers.deadwood.verdict).toBe("unsure");
	});
});

describe("labelers and models", () => {
	it("finds labelers who disagree on a layer verdict or the image gate", () => {
		const a = [person("a", { layer: "image" }), person("a", { verdict: "major" })];
		const b = [person("b", { layer: "image" }), person("b", { verdict: "major" })];
		expect(labelersDisagree("prediction_quality", [...a, ...b])).toBe(false);
		expect(labelersDisagree("prediction_quality", [...a, person("c", { layer: "image", verdict: "major" })])).toBe(true);
		expect(labelersDisagree("prediction_quality", a)).toBe(false);
	});

	it("reads a model's problem as yes at 50 or more", () => {
		const model = person("x", { assessor_kind: "model", assessor_user_id: null, modes: { m1_dead_missed: { likelihood: 60 }, m7_dw_artifact: { likelihood: 20 } } });
		expect(problemAnswer(model, "m1_dead_missed")).toBe("yes");
		expect(problemAnswer(model, "m7_dw_artifact")).toBe("no");
		expect(problemAnswer(person("p", { details: { unsure_modes: ["m3_dw_on_non_vegetation"] } }), "m3_dw_on_non_vegetation")).toBe("unsure");
	});

	it("marks who flags what the other did not", () => {
		expect(agreement("no", "yes")).toBe("they_flag");
		expect(agreement("major", "ok")).toBe("you_flag");
		expect(agreement("minor", "minor")).toBe("agree");
		expect(agreement(null, "yes")).toBeNull();
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
		expect(nextOpen([targets[1]], 2, "me")).toBeNull();
	});
});

describe("dataset evaluation labels", () => {
	it("stores keep with a fix flag as keep, fix, and excluding needs a reason", () => {
		expect(evaluationAnswerRow({ verdict: "ok", reason: null, flags: ["cog_issue"], note: "" }, 5)).toEqual({
			rows: [expect.objectContaining({ verdict: "minor", reason_code: null, details: { fix_flags: ["cog_issue"] }, run_id: null, layer: "image" })],
		});
		expect(evaluationAnswerRow({ verdict: "major", reason: null, flags: [], note: "" }, 5)).toEqual({ missing: "Excluding needs a reason" });
		expect(evaluationAnswerRow({ verdict: "major", reason: "blurry", flags: [], note: " soft " }, 5)).toEqual({
			rows: [expect.objectContaining({ verdict: "major", reason_code: "blurry", reason_text: "soft", details: { fix_flags: [] } })],
		});
		expect(evaluationAnswerRow({ verdict: null, reason: null, flags: [], note: "" }, 5)).toEqual({ missing: expect.any(String) });
	});
});
