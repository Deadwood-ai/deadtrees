/** Contract and pure helpers for `factory_north_star`: weekly outcomes and monthly cohorts. */

export interface NorthStarWeek {
	start: string;
	end: string;
	partial: boolean;
	signups: number;
	first_uploaders: number;
	uploads: number;
	/** Null before completion times were recorded. */
	results: number | null;
	reach_eligible: number | null;
	not_reached_7d: number | null;
	geotiff_p50_hours: number | null;
	geotiff_p90_hours: number | null;
	geotiff_samples: number;
	odm_p50_hours: number | null;
	odm_p90_hours: number | null;
	odm_samples: number;
	audited_usable: number;
	published: number;
	downloads: number | null;
	reuse_downloads: number | null;
}

export interface NorthStarCohort {
	start: string;
	end: string;
	signups: number;
	activation_eligible: number;
	activated_30d: number;
	new_contributors: number;
	retention_eligible: number;
	returned_90d: number;
}

export type NorthStarStep = "late" | "upload" | "odm" | "ortho" | "cog" | "thumbnail" | "metadata" | "segmentation" | "aoi" | "unrecorded";

export interface NorthStarStalled {
	step: NorthStarStep;
	datasets: number;
	with_error: number;
}

export interface FactoryNorthStar {
	as_of: string;
	include_team: boolean;
	team_accounts: number;
	run_since: string | null;
	download_since: string | null;
	weekly: NorthStarWeek[];
	cohorts: NorthStarCohort[];
	stalled: NorthStarStalled[];
	coverage: string[];
}

export const STEP_LABELS: Record<NorthStarStep, string> = {
	late: "Reached a result after more than 7 days",
	upload: "Upload never finished",
	odm: "Raw-image reconstruction (ODM)",
	ortho: "Orthophoto conversion",
	cog: "Cloud-optimised GeoTIFF",
	thumbnail: "Thumbnail",
	metadata: "Metadata",
	segmentation: "Deadwood and forest-cover segmentation",
	aoi: "Area of interest",
	unrecorded: "Complete now, completion time not recorded",
};

/** Whether a rising value is good news. Drives the colour of week-over-week changes. */
export type Direction = "up" | "down";

export interface Comparison {
	current: number | null;
	previous: number | null;
	/** current − previous, or null when either side is unknown. */
	change: number | null;
	/** "good" | "bad" | "flat" | "unknown" relative to the metric's direction. */
	verdict: "good" | "bad" | "flat" | "unknown";
}

export function compare(current: number | null | undefined, previous: number | null | undefined, direction: Direction): Comparison {
	const c = current ?? null;
	const p = previous ?? null;
	if (c === null || p === null) return { current: c, previous: p, change: null, verdict: "unknown" };
	const change = c - p;
	if (Math.abs(change) < 1e-9) return { current: c, previous: p, change: 0, verdict: "flat" };
	return { current: c, previous: p, change, verdict: (change > 0) === (direction === "up") ? "good" : "bad" };
}

/** The last two complete weeks: the current partial week never drives a headline. */
export function completeWeeks(weeks: NorthStarWeek[]): { latest: NorthStarWeek | null; previous: NorthStarWeek | null } {
	const complete = weeks.filter((week) => !week.partial);
	return { latest: complete.at(-1) ?? null, previous: complete.at(-2) ?? null };
}

/** Share as a 0–100 percentage, or null when nothing is eligible yet. */
export function share(count: number | null | undefined, eligible: number | null | undefined): number | null {
	if (count === null || count === undefined || !eligible) return null;
	return (count / eligible) * 100;
}

/** Latest two weeks whose value is known, for metrics that only mature after a delay (7-day reach). */
export function latestKnown<T>(items: T[], value: (item: T) => number | null): { latest: T | null; previous: T | null } {
	const known = items.filter((item) => value(item) !== null);
	return { latest: known.at(-1) ?? null, previous: known.at(-2) ?? null };
}

/** Sum of a weekly field over the last `count` complete weeks; null when any week is unknown. */
export function sumRecent(weeks: NorthStarWeek[], pick: (week: NorthStarWeek) => number | null, count: number): number | null {
	const recent = weeks.filter((week) => !week.partial).slice(-count);
	if (recent.length === 0) return null;
	let total = 0;
	for (const week of recent) {
		const value = pick(week);
		if (value === null) return null;
		total += value;
	}
	return total;
}

export function formatPercent(value: number): string {
	return `${Math.round(value)}%`;
}

export function formatPoints(change: number): string {
	const rounded = Math.round(change);
	return `${rounded > 0 ? "+" : rounded < 0 ? "−" : "±"}${Math.abs(rounded)} pts`;
}

export function formatSignedCount(change: number): string {
	const rounded = Math.round(change);
	return `${rounded > 0 ? "+" : rounded < 0 ? "−" : "±"}${Math.abs(rounded).toLocaleString()}`;
}
