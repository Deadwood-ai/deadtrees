import { describe, expect, it } from "vitest";
import type { IAuditDatasetResult } from "../types/auditChecks";
import { NO_FILTERS, TABS, activeFilterCount, filterRows, filtersFromParams, listParams, nextPendingReview, stagesOf, tabOf, type IAuditListRow } from "./auditReviewList";

const row = (id: number, result: Partial<IAuditDatasetResult> | null, over: Partial<IAuditListRow> = {}): IAuditListRow => ({
	id,
	dataset: { id, admin_level_1: "Germany" } as IAuditListRow["dataset"],
	result: result && ({ dataset_id: id, review_required: [], is_processing_done: true, current_status: "idle", ...result } as IAuditDatasetResult),
	reviewers: [],
	flags: 0,
	edits: 0,
	reference: false,
	...over,
});

const rows = [
	row(1, { evaluation_decision: "keep", georef_status: "estimated", date_replace: false, deadwood_total: 10, deadwood_major: 0 }),
	row(2, { review_required: ["evaluation", "georef"], georef_status: "needs_review", deadwood_total: 10, deadwood_major: 5, in_benchmark: true }, { reviewers: ["a@x.org"] }),
	row(3, { evaluation_decision: "exclude", date_replace: true, is_processing_done: false, current_status: "cog_processing" }, { flags: 1 }),
	row(4, null, { reference: true, dataset: { id: 4, admin_level_1: "Spain" } as IAuditListRow["dataset"] }),
];
const ids = (list: IAuditListRow[]) => list.map((r) => r.id);

describe("tabs", () => {
	it("are the whole list with one fixed chip each, newest first", () => {
		expect(ids(filterRows(rows, "all", NO_FILTERS))).toEqual([4, 3, 2, 1]);
		expect(ids(filterRows(rows, "pending", NO_FILTERS))).toEqual([2]);
		expect(ids(filterRows(rows, "benchmark", NO_FILTERS))).toEqual([]);
		expect(ids(filterRows(rows, "edits-flags", NO_FILTERS))).toEqual([3]);
		expect(ids(filterRows(rows, "reference", NO_FILTERS))).toEqual([4]);
		expect(TABS.slice(0, 3).map((t) => [t.label, t.chip])).toEqual([
			["All audits", null],
			["Pending audit reviews", "Review required"],
			["Benchmark", null],
		]);
	});

	it("falls back to All audits for an unknown tab", () => {
		expect(tabOf("re-review")).toBe("all");
		expect(tabOf("pending")).toBe("pending");
	});
});

describe("filters", () => {
	const only = (patch: Partial<typeof NO_FILTERS>) => ids(filterRows(rows, "all", { ...NO_FILTERS, ...patch }));

	it("filter by each check's output", () => {
		expect(only({ decision: "exclude" })).toEqual([3]);
		expect(only({ decision: "none" })).toEqual([4, 2]);
		expect(only({ georef: "needs_review" })).toEqual([2]);
		expect(only({ dateReplaced: "yes" })).toEqual([3]);
		expect(only({ dateReplaced: "no" })).toEqual([1]);
		expect(only({ majorShare: 25 })).toEqual([2]);
	});

	it("filter by the review and the dataset", () => {
		expect(only({ reviewRequired: true })).toEqual([2]);
		expect(only({ inBenchmark: true })).toEqual([2]);
		expect(only({ reviewedBy: "a@x.org" })).toEqual([2]);
		expect(only({ id: " 3 " })).toEqual([3]);
		expect(only({ country: "Spain" })).toEqual([4]);
		expect(only({ stage: "finished" })).toEqual([2, 1]);
		expect(only({ stage: "unfinished" })).toEqual([4, 3]);
		expect(only({ stage: "cog_processing" })).toEqual([3]);
		expect(stagesOf(rows)).toEqual(["cog_processing"]);
	});

	it("round-trip through the URL and count what is set", () => {
		const filters = { ...NO_FILTERS, decision: "exclude" as const, majorShare: 10, reviewRequired: true, reviewedBy: "a@x.org" };
		const params = listParams("pending", filters);
		expect(params.toString()).toBe("tab=pending&decision=exclude&major=10&review=1&reviewer=a%40x.org");
		expect(filtersFromParams(params)).toEqual(filters);
		expect(activeFilterCount(filters)).toBe(4);
		expect(activeFilterCount(NO_FILTERS)).toBe(0);
	});
});

describe("Save & Next", () => {
	const row = (dataset_id: number, review_required: string[]) => ({ dataset_id, review_required }) as Pick<IAuditDatasetResult, "dataset_id" | "review_required">;
	const rows = [row(30, ["georef"]), row(20, []), row(15, ["date"]), row(10, ["dataset_evaluation"])];

	it("goes on to the next dataset that needs review, newest first, from any dataset", () => {
		expect(nextPendingReview(rows, 30)).toBe(15);
		expect(nextPendingReview(rows, 20)).toBe(15);
		expect(nextPendingReview(rows, 25)).toBe(15);
	});

	it("wraps round, and stops when no other dataset needs review", () => {
		expect(nextPendingReview(rows, 10)).toBe(30);
		expect(nextPendingReview([row(10, ["georef"])], 10)).toBeNull();
	});
});
