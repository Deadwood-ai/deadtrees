import { describe, expect, it } from "vitest";
import type { ITileJudgement } from "../types/auditChecks";
import { cropFindings } from "./tileFindings";

const judgement = (over: Partial<ITileJudgement>): ITileJudgement => ({
	id: 1,
	run_id: 5,
	tile_id: 7,
	layer: "deadwood",
	judge: "luna-medium",
	verdict: "major",
	problems: null,
	summary: null,
	...over,
});

describe("cropFindings", () => {
	it("says what each model saw in a tile: its likely error types with their share, and its words", () => {
		const luna = judgement({
			problems: { m1_dead_missed: { likelihood: 95, area_pct: 3 }, m4_dw_on_lying_wood: { likelihood: 40, area_pct: 1 } },
			summary: " Most dead crowns are unmarked. ",
		});
		expect(cropFindings([luna], 7, "deadwood", 2)).toEqual([
			{
				model: "Luna",
				decides: false,
				verdict: "major",
				summary: "Most dead crowns are unmarked.",
				issues: [{ key: "m1_dead_missed", label: "Dead trees missed", likelihood: 95, areaPct: 3 }],
			},
		]);
	});

	it("marks the answer the call rests on, puts it first and leaves other tiles and layers out", () => {
		const rows = [
			judgement({ id: 1 }),
			judgement({ id: 2, judge: "haiku-5.5", verdict: "ok" }),
			judgement({ id: 3, layer: "forest_cover" }),
			judgement({ id: 4, tile_id: 8 }),
		];
		expect(cropFindings(rows, 7, "deadwood", 2).map((f) => [f.model, f.decides])).toEqual([
			["Haiku", true],
			["Luna", false],
		]);
		// two judges with the same name prefix: only the call's answer decides
		const twins = [judgement({ id: 5, judge: "haiku-5.5" }), judgement({ id: 6, judge: "haiku-4.5" })];
		expect(cropFindings(twins, 7, "deadwood", 6).map((f) => [f.decides, f.verdict])).toEqual([
			[true, "major"],
			[false, "major"],
		]);
		expect(cropFindings(twins, 7, "deadwood", 6)[0].model).toBe("Haiku");
		// a call without a judge's answer marks none
		expect(cropFindings(rows, 7, "deadwood", null).every((f) => !f.decides)).toBe(true);
	});
});
