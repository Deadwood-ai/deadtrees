import { describe, expect, it } from "vitest";
import { compare, completeWeeks, formatPoints, formatSignedCount, latestKnown, share, sumRecent, type NorthStarWeek } from "./factoryNorthStarMetrics";

const week = (start: string, partial: boolean, results: number | null, signups = 1): NorthStarWeek => ({
	start,
	end: start,
	partial,
	signups,
	first_uploaders: 0,
	uploads: 0,
	results,
	reach_eligible: null,
	not_reached_7d: null,
	geotiff_p50_hours: null,
	geotiff_p90_hours: null,
	geotiff_samples: 0,
	odm_p50_hours: null,
	odm_p90_hours: null,
	odm_samples: 0,
	audited_usable: 0,
	published: 0,
	downloads: null,
	reuse_downloads: null,
});

describe("north-star comparisons", () => {
	it("judges a change by the metric's good direction", () => {
		expect(compare(12, 10, "up")).toMatchObject({ change: 2, verdict: "good" });
		expect(compare(12, 10, "down")).toMatchObject({ change: 2, verdict: "bad" });
		expect(compare(8, 10, "down")).toMatchObject({ change: -2, verdict: "good" });
		expect(compare(10, 10, "up")).toMatchObject({ change: 0, verdict: "flat" });
	});

	it("never invents a change from an unknown side", () => {
		expect(compare(null, 10, "up")).toMatchObject({ change: null, verdict: "unknown" });
		expect(compare(3, undefined, "up")).toMatchObject({ current: 3, previous: null, verdict: "unknown" });
	});

	it("ignores the running week for the headline", () => {
		const { latest, previous } = completeWeeks([week("a", false, 1), week("b", false, 2), week("c", true, 99)]);
		expect(latest?.start).toBe("b");
		expect(previous?.start).toBe("a");
	});

	it("uses the newest known values for metrics that mature late", () => {
		const items = [{ v: 1 }, { v: 2 }, { v: null }];
		expect(latestKnown(items, (item) => item.v)).toEqual({ latest: { v: 2 }, previous: { v: 1 } });
	});
});

describe("north-star aggregation", () => {
	it("shares need an eligible population", () => {
		expect(share(1, 4)).toBe(25);
		expect(share(0, 0)).toBeNull();
		expect(share(null, 4)).toBeNull();
	});

	it("sums recent complete weeks and stays unknown if any week is", () => {
		const weeks = [week("a", false, 1, 5), week("b", false, 2, 6), week("c", false, 3, 7), week("d", true, 50, 50)];
		expect(sumRecent(weeks, (item) => item.signups, 2)).toBe(13);
		expect(sumRecent(weeks, (item) => item.results, 3)).toBe(6);
		expect(sumRecent([week("a", false, null), week("b", false, 2)], (item) => item.results, 2)).toBeNull();
	});

	it("formats signed changes", () => {
		expect(formatPoints(4.4)).toBe("+4 pts");
		expect(formatPoints(-3)).toBe("−3 pts");
		expect(formatSignedCount(1200)).toBe("+1,200");
		expect(formatSignedCount(0)).toBe("±0");
	});
});
