import { describe, expect, it } from "vitest";
import {
	countActiveFilters,
	factoryDatasetsPath,
	filtersFromRecord,
	parseFactoryFilters,
	parseIdList,
	serializeFactoryFilters,
	toRpcFilters,
} from "./factoryFilters";

describe("parseFactoryFilters", () => {
	it("keeps only known values and drops invalid ones", () => {
		const params = new URLSearchParams(
			"search=%20oak%20&state=failed&notification=problem&publication=nope&reports=open&archived=yes&attention=true&uploaded=false&ready=true&has_error=true&ids=671,%2010494;x&worker=helicon&created_after=2026-09-14T00:00:00.000Z&created_before=not-a-date"
		);
		expect(parseFactoryFilters(params)).toEqual({
			search: "oak",
			state: "failed",
			notification: "problem",
			reports: "open",
			archived: "yes",
			attention: true,
			uploaded: false,
			ready: true,
			has_error: true,
			ids: [671, 10494],
			worker: "helicon",
			created_after: "2026-09-14T00:00:00.000Z",
		});
	});

	it("parses ledger drilldown filters and drops the all values", () => {
		const params = new URLSearchParams(
			"metric=first_ready&metric_after=2026-09-14T00:00:00.000Z&metric_before=2026-09-21T00:00:00.000Z&workflow=geotiff&size=all&archived=all"
		);
		const filters = parseFactoryFilters(params);
		expect(filters).toEqual({
			metric: "first_ready",
			metric_after: "2026-09-14T00:00:00.000Z",
			metric_before: "2026-09-21T00:00:00.000Z",
			workflow: "geotiff",
			archived: "all",
		});
		expect(toRpcFilters({ ...filters, size: "all" })).toEqual({
			metric: "first_ready",
			metric_after: "2026-09-14T00:00:00.000Z",
			metric_before: "2026-09-21T00:00:00.000Z",
			workflow: "geotiff",
			archived: "all",
		});
		expect(parseFactoryFilters(new URLSearchParams("metric=bogus&workflow=all")).metric).toBeUndefined();
	});

	it("ignores an unknown state and a false attention flag", () => {
		expect(parseFactoryFilters(new URLSearchParams("state=running&attention=false"))).toEqual({});
	});

	it("round-trips through serialize", () => {
		const params = new URLSearchParams("state=claimed&notification=sent&ids=3,4&archived=all&has_audit=false");
		const filters = parseFactoryFilters(params);
		expect(parseFactoryFilters(serializeFactoryFilters(filters))).toEqual(filters);
	});
});

describe("toRpcFilters", () => {
	it("omits unset keys and the default archived value", () => {
		expect(toRpcFilters({ state: "queued", archived: "no", search: "", ids: [] })).toEqual({ state: "queued" });
		expect(toRpcFilters({ archived: "all", attention: true })).toEqual({ archived: "all", attention: true });
	});

	it("counts only the filters that reach the server", () => {
		expect(countActiveFilters({ archived: "no" })).toBe(0);
		expect(countActiveFilters({ state: "failed", reports: "open" })).toBe(2);
	});
});

describe("factoryDatasetsPath", () => {
	it("builds a stable link and only adds pages beyond the first", () => {
		expect(factoryDatasetsPath({})).toBe("/factory/datasets");
		expect(factoryDatasetsPath({ state: "failed" }, 1)).toBe("/factory/datasets?state=failed");
		expect(factoryDatasetsPath({ state: "failed" }, 3)).toBe("/factory/datasets?state=failed&page=3");
	});
});

describe("attention sort", () => {
	it("round-trips the server-owned sort and does not count it as a filter", () => {
		const filters = parseFactoryFilters(new URLSearchParams("attention=true&sort=attention&sort_dir=desc"));
		expect(filters).toEqual({ attention: true, sort: "attention" });
		expect(serializeFactoryFilters(filters).toString()).toBe("attention=true&sort=attention");
		expect(toRpcFilters(filters)).toEqual({ attention: true, sort: "attention" });
		expect(countActiveFilters(filters)).toBe(1);
		expect(parseFactoryFilters(new URLSearchParams("sort=random")).sort).toBeUndefined();
	});

	it("validates filter objects handed over by the server", () => {
		expect(filtersFromRecord({ state: "queued", bogus: "x", reports: "open", ids: [1, 2] })).toEqual({ state: "queued", reports: "open", ids: [1, 2] });
		expect(filtersFromRecord(null)).toEqual({});
	});
});

describe("parseIdList", () => {
	it("accepts separators and hashes, rejects junk and duplicates", () => {
		expect(parseIdList("#671, 10494\n10494;  abc 0 -3")).toEqual([671, 10494]);
		expect(parseIdList("")).toEqual([]);
	});
});

it("drops malformed contributor UUID filters", () => {
 expect(parseFactoryFilters(new URLSearchParams("contributor=person@example.com"))).not.toHaveProperty("contributor");
});
