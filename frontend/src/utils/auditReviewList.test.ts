import { describe, expect, it } from "vitest";
import {
	COUNTED_TABS,
	NEWEST_FIRST,
	NO_FILTERS,
	PROCESSING_STAGES,
	TABS,
	activeFilterCount,
	filtersFromParams,
	listConditions,
	listOfPath,
	listOrder,
	listParams,
	stageState,
	tabOf,
	type IAuditListRow,
} from "./auditReviewList";

describe("tabs", () => {
	it("are the whole list with one fixed condition each", () => {
		expect(listConditions("all", NO_FILTERS)).toEqual([]);
		expect(listConditions("pending", NO_FILTERS)).toEqual([["review_required", "neq", "{}"]]);
		expect(listConditions("edits-flags", NO_FILTERS)).toEqual([{ or: "flags.gt.0,edits.gt.0" }]);
		expect(listConditions("reference", NO_FILTERS)).toEqual([["reference", "is", "true"]]);
		// the benchmark tab lists no datasets: no query, no count
		expect(listConditions("benchmark", NO_FILTERS)).toBeNull();
		expect(COUNTED_TABS).toEqual(["all", "pending", "edits-flags", "reference"]);
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
	const only = (patch: Partial<typeof NO_FILTERS>) => listConditions("all", { ...NO_FILTERS, ...patch });

	it("filter by each check's output", () => {
		expect(only({ decision: "exclude" })).toEqual([["evaluation_decision", "eq", "exclude"]]);
		expect(only({ decision: "none" })).toEqual([["evaluation_decision", "is", "null"]]);
		expect(only({ georef: "needs_review" })).toEqual([["georef_status", "eq", "needs_review"]]);
		expect(only({ georef: "none" })).toEqual([["georef_status", "is", "null"]]);
		expect(only({ dateReplaced: "yes" })).toEqual([["date_replace", "is", "true"]]);
		expect(only({ dateReplaced: "no" })).toEqual([["date_replace", "is", "false"]]);
		expect(only({ majorShare: 25 })).toEqual([["major_share", "gte", "25"]]);
	});

	it("filter by the review, the dataset and its processing", () => {
		expect(only({ review: "any" })).toEqual([["review_required", "neq", "{}"]]);
		expect(only({ review: "georef" })).toEqual([["review_required", "cs", "{georef}"]]);
		expect(only({ inBenchmark: true })).toEqual([["in_benchmark", "is", "true"]]);
		expect(only({ reviewedBy: "u-1" })).toEqual([["reviewers", "cs", "{u-1}"]]);
		expect(only({ id: " 3 " })).toEqual([["dataset_id", "eq", "3"]]);
		// not a number: no dataset, not a failed request
		expect(only({ id: "abc" })).toEqual([["dataset_id", "eq", "0"]]);
		expect(only({ country: "Spain" })).toEqual([["admin_level_1", "eq", "Spain"]]);
		expect(only({ stage: "finished" })).toEqual([["is_processing_done", "is", "true"]]);
		// not finished leaves the failed datasets to their own choice
		expect(only({ stage: "unfinished" })).toEqual([
			["is_processing_done", "is", "false"],
			["has_error", "is", "false"],
		]);
		expect(only({ stage: "failed" })).toEqual([["has_error", "is", "true"]]);
		expect(only({ stage: "cog_processing" })).toEqual([["current_status", "eq", "cog_processing"]]);
		// a tab's condition and the filters together
		expect(listConditions("pending", { ...NO_FILTERS, country: "Spain" })).toEqual([
			["review_required", "neq", "{}"],
			["admin_level_1", "eq", "Spain"],
		]);
	});

	it("round-trip through the URL and count what is set", () => {
		const filters = { ...NO_FILTERS, decision: "exclude" as const, majorShare: 10, review: "georef" as const, reviewedBy: "u-1" };
		const params = listParams("pending", filters);
		expect(params.toString()).toBe("tab=pending&decision=exclude&major=10&review=georef&reviewer=u-1");
		expect(filtersFromParams(params)).toEqual(filters);
		expect(listOfPath(`/dataset-audit?${params}`)).toEqual({ tab: "pending", filters });
		expect(listOfPath("/dataset-audit")).toEqual({ tab: "all", filters: NO_FILTERS });
		expect(activeFilterCount(filters)).toBe(4);
		expect(activeFilterCount(NO_FILTERS)).toBe(0);
		// an unknown reason in an old link is no filter, not an empty list
		expect(filtersFromParams(new URLSearchParams("review=1")).review).toBeNull();
	});
});

describe("sort", () => {
	it("is newest first by default; a missing value is the smallest and ties go newest first", () => {
		expect(listOrder(NEWEST_FIRST)).toEqual([{ column: "dataset_id", ascending: false }]);
		expect(listOrder({ key: "id", ascending: true })).toEqual([{ column: "dataset_id", ascending: true }]);
		expect(listOrder({ key: "phenology", ascending: true })).toEqual([
			{ column: "phenology_probability", ascending: true, nullsFirst: true },
			{ column: "dataset_id", ascending: false },
		]);
		expect(listOrder({ key: "date", ascending: false }).map((o) => o.column)).toEqual(["aquisition_year", "aquisition_month", "aquisition_day", "dataset_id"]);
	});
});

describe("processing stages", () => {
	const row = (over: Partial<IAuditListRow>) =>
		({ ...Object.fromEntries(PROCESSING_STAGES.map((s) => [s.done, false])), current_status: "idle", has_error: false, failed_stage: null, ...over }) as IAuditListRow;
	const cog = PROCESSING_STAGES.find((s) => s.done === "is_cog_done")!;

	it("each stage succeeded, failed, runs or has not run", () => {
		expect(stageState(row({ is_cog_done: true }), cog)).toBe("succeeded");
		expect(stageState(row({}), cog)).toBe("not_run");
		expect(stageState(row({ current_status: "cog_processing", is_cog_done: true }), cog)).toBe("running");
		expect(stageState(row({ has_error: true, failed_stage: "cog_processing" }), cog)).toBe("failed");
		// a failure with an unknown stage is no stage's
		expect(stageState(row({ has_error: true, failed_stage: "unknown" }), cog)).toBe("not_run");
	});
});
