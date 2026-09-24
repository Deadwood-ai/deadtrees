import { describe, expect, it } from "vitest";
import {
	evidenceNote,
	bucketLongLabel,
	bucketRangeLabel,
	bucketShortLabel,
	formatGib,
	formatHours,
	formatSeconds,
	formatShare,
	toTrendBuckets,
} from "./factoryTrends";
import type { FactoryTrendPoint } from "./factoryTypes";

const point: FactoryTrendPoint = {
	start: "2026-09-14T00:00:00Z",
	end: "2026-09-21T00:00:00Z",
	partial: false,
	uploaded: 12,
	uploaded_measured: 4,
	first_ready: 9,
	first_ready_measured: 3,
	lead_p50_hours: 0.75,
	lead_p90_hours: 2.5,
	completed_input_gib: 12.5,
	volume_samples: 8,
	failures_first_result: 2,
	failures_other: 1,
	failures_measured: 0,
	recovered: 2,
	recovered_measured: 2,
	recovery_p50_hours: 1.5,
	recovery_p90_hours: null,
	recovery_samples: 2,
};

describe("bucket labels", () => {
	it("labels weeks by their UTC range and days by their date", () => {
		expect(bucketShortLabel(point.start)).toBe("Sep 14");
		expect(bucketRangeLabel(point.start, point.end, "week")).toBe("Sep 14–20");
		expect(bucketRangeLabel("2026-09-28T00:00:00Z", "2026-10-05T00:00:00Z", "week")).toBe("Sep 28–Oct 4");
		expect(bucketShortLabel("2026-09-14T00:00:00Z")).toBe("Sep 14");
		expect(bucketLongLabel(point.start, point.end, "week")).toBe("Week Sep 14–20 2026 (UTC)");
		expect(bucketShortLabel("garbage")).toBe("garbage");
	});

	it("labels months by month and year", () => {
		expect(bucketShortLabel("2025-10-01T00:00:00Z", "month")).toBe("Oct 2025");
		expect(bucketRangeLabel("2025-10-01T00:00:00Z", "2025-11-01T00:00:00Z", "month")).toBe("Oct 2025");
		expect(bucketLongLabel("2025-10-01T00:00:00Z", "2025-11-01T00:00:00Z", "month")).toBe("Oct 2025 (UTC)");
	});
});

describe("formatting", () => {
	it("formats durations and sizes for humans", () => {
		expect(formatSeconds(30)).toBe("<1 min");
		expect(formatSeconds(2700)).toBe("45 min");
		expect(formatHours(1.3333)).toBe("1 h 20 min");
		expect(formatHours(27)).toBe("1 d 3 h");
		expect(formatGib(0.5)).toBe("0.50 GiB");
		expect(formatGib(12.34)).toBe("12.3 GiB");
		expect(formatGib(250)).toBe("250 GiB");
	});

});

describe("chart buckets", () => {
	it("carries population, completeness and picked values", () => {
		const [bucket] = toTrendBuckets([point], "week", (item) => ({
			n: item.first_ready,
			values: { p50: item.lead_p50_hours, p90: item.lead_p90_hours, recovery: item.recovery_p90_hours },
		}));
		expect(bucket).toEqual({
			key: point.start,
			label: "Week Sep 14–20 2026 (UTC)",
			shortLabel: "Sep 14",
			complete: true,
			n: 9,
			values: { p50: 0.75, p90: 2.5, recovery: null },
		});
	});

	it("marks partial intervals as incomplete and keeps unknown values null", () => {
		const [bucket] = toTrendBuckets([{ ...point, partial: true, uploaded: null, first_ready: null }], "day", (item) => ({
			note: evidenceNote(item.recovered, item.recovered_measured),
			values: { uploaded: item.uploaded, first_ready: item.first_ready, recovered: item.recovered },
		}));
		expect(bucket.n).toBeUndefined();
		expect(bucket.complete).toBe(false);
		expect(bucket.shortLabel).toBe("Sep 14");
		expect(bucket.note).toBe("all measured");
		expect(bucket.values).toEqual({ uploaded: null, first_ready: null, recovered: 2 });
	});
});

describe("evidenceNote", () => {
	it("says which evidence a count rests on and stays silent when there is nothing to say", () => {
		expect(evidenceNote(12, 4)).toBe("4 measured, 8 reconstructed from logs");
		expect(evidenceNote(9, 0)).toBe("all reconstructed from logs");
		expect(evidenceNote(2, 2)).toBe("all measured");
		expect(evidenceNote(0, 0)).toBe("");
		expect(evidenceNote(null, null)).toBe("");
	});
});

describe("formatShare", () => {
	it("shows n of N, adds a share only for larger eligible groups, and never invents a rate", () => {
		expect(formatShare(2, 3)).toBe("2 of 3");
		expect(formatShare(4, 8)).toBe("4 of 8 (50%)");
		expect(formatShare(0, 0)).toBe("none eligible yet");
		expect(formatShare(null, 0)).toBe("none eligible yet");
		expect(formatShare(null, 8)).toBe("unknown");
		expect(formatShare(2, null)).toBe("unknown");
	});
});
