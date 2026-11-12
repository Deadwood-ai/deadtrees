import { describe, expect, it } from "vitest";
import type { IAuditQueueRow } from "../types/auditChecks";
import { datasetReviewRows, reviewHref, reviewTargets } from "./auditReviewList";

const row = (dataset_id: number, check_key: IAuditQueueRow["check_key"], layer: IAuditQueueRow["layer"], verdict: IAuditQueueRow["verdict"] = "ok"): IAuditQueueRow => ({
	dataset_id,
	check_key,
	layer,
	run_id: dataset_id * 10,
	verdict,
	reason: "review_all",
});

const queue = [
	row(1, "dataset_evaluation", "image"),
	row(1, "georef", "georef", "major"),
	row(1, "prediction_quality", "deadwood", "unsure"),
	row(1, "prediction_quality", "forest_cover"),
	// no georeferencing run
	row(2, "dataset_evaluation", "image"),
	row(2, "prediction_quality", "deadwood"),
	row(2, "prediction_quality", "forest_cover"),
];

describe("reviewTargets", () => {
	it("has a column per check layer in audit page order", () => {
		expect(reviewTargets(queue).map((t) => [t.key, t.title])).toEqual([
			["dataset_evaluation:image", "Dataset evaluation"],
			["georef:georef", "Georeferencing"],
			["prediction_quality:deadwood", "Deadwood"],
			["prediction_quality:forest_cover", "Tree cover"],
		]);
	});

	it("gives a check that runs nowhere no column", () => {
		expect(reviewTargets(queue.filter((r) => r.check_key !== "georef")).map((t) => t.checkKey)).not.toContain("georef");
	});
});

describe("datasetReviewRows", () => {
	const targets = reviewTargets(queue);

	it("groups the results into one row per dataset, newest first", () => {
		const rows = datasetReviewRows(queue, {}, targets);
		expect(rows.map((r) => r.datasetId)).toEqual([2, 1]);
		expect(rows[1].cells["georef:georef"]?.verdict).toBe("major");
	});

	it("marks a dataset complete only when every check ran", () => {
		const [two, one] = datasetReviewRows(queue, {}, targets);
		expect(one.complete).toBe(true);
		expect(two.complete).toBe(false);
		expect(two.cells["georef:georef"]).toBeUndefined();
	});

	it("counts the results that are not ok", () => {
		const [, one] = datasetReviewRows(queue, {}, targets);
		expect(one.problems).toBe(2);
	});

	it("opens the first check you have not answered and is finished when you answered all", () => {
		const reviews = {
			"1:dataset_evaluation:image": { count: 2, mine: true },
			"1:georef:georef": { count: 1, mine: false },
		};
		const [, one] = datasetReviewRows(queue, reviews, targets);
		expect(one.cells["dataset_evaluation:image"]).toEqual({ verdict: "ok", reviews: 2, mine: true });
		expect(one.finished).toBe(false);
		expect(reviewHref(one)).toBe("/dataset-audit/1?section=georef");

		const all = Object.fromEntries(queue.filter((r) => r.dataset_id === 1).map((r) => [`1:${r.check_key}:${r.layer}`, { count: 1, mine: true }]));
		const [, done] = datasetReviewRows(queue, all, targets);
		expect(done.finished).toBe(true);
		expect(reviewHref(done)).toBe("/dataset-audit/1?section=evaluation");
	});
});
