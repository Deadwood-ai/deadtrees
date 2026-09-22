import type { FactoryTrendInterval, FactoryTrendPoint } from "./factoryTypes";
import type { TrendBucket } from "./FactoryTrendChart";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const utcParts = (iso: string) => {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? null : { m: date.getUTCMonth(), d: date.getUTCDate(), y: date.getUTCFullYear() };
};

/** Axis tick: the bucket's start date, "Sep 14". Falls back to the raw start. */
export function bucketShortLabel(start: string): string {
	const from = utcParts(start);
	return from ? `${MONTHS[from.m]} ${from.d}` : start;
}

/** "Sep 14–20" for weeks, "Sep 14" for days; used where there is room. */
export function bucketRangeLabel(start: string, end: string, bucket: FactoryTrendInterval): string {
	const from = utcParts(start);
	if (!from) return start;
	if (bucket === "day") return `${MONTHS[from.m]} ${from.d}`;
	const to = utcParts(new Date(new Date(end).getTime() - 1).toISOString());
	if (!to) return `${MONTHS[from.m]} ${from.d}`;
	return from.m === to.m ? `${MONTHS[from.m]} ${from.d}–${to.d}` : `${MONTHS[from.m]} ${from.d}–${MONTHS[to.m]} ${to.d}`;
}

export function bucketLongLabel(start: string, end: string, bucket: FactoryTrendInterval): string {
	const from = utcParts(start);
	if (!from) return start;
	const range = bucketRangeLabel(start, end, bucket);
	return bucket === "day" ? `${range} ${from.y} (UTC)` : `Week ${range} ${from.y} (UTC)`;
}

/** Seconds to a short duration such as "48 min", "1 h 20 min" or "2 d 3 h". */
export function formatSeconds(seconds: number): string {
	if (seconds < 60) return "<1 min";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest ? `${hours} h ${rest} min` : `${hours} h`;
	}
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours ? `${days} d ${restHours} h` : `${days} d`;
}

/** Hours (as the ledger reports them) to a short duration. */
export function formatHours(hours: number): string {
	return formatSeconds(hours * 3600);
}

export function formatGib(value: number): string {
	if (value >= 100) return `${Math.round(value)} GiB`;
	if (value >= 10) return `${value.toFixed(1)} GiB`;
	return `${value.toFixed(2)} GiB`;
}

export function formatCount(value: number): string {
	return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(1);
}


export function toTrendBuckets(
	points: FactoryTrendPoint[],
	interval: FactoryTrendInterval,
	pick: (point: FactoryTrendPoint) => { n?: number | null; values: Record<string, number | null> }
): TrendBucket[] {
	return points.map((point) => ({
		key: point.start,
		label: bucketLongLabel(point.start, point.end, interval),
		shortLabel: bucketShortLabel(point.start),
		complete: !point.partial,
		...pick(point),
	}));
}

export const TREND_COLORS = {
	uploaded: "#88B5E0",
	ready: "#1B5E35",
	failed: "#EF4444",
	recovered: "#22C55E",
	p50: "#2E7AC0",
	p90: "#AE5920",
	input: "#1F5FAF",
	registered: "#D7C49A",
	recordedCompleted: "#7CE380",
	recordedFailed: "#F0A0A0",
	recordedEmbedding: "#C8F0D8",
} as const;

/** "n of N" with a share only when the eligible group is large enough to mean something. */
export function formatShare(count: number | null, eligible: number | null, minimumForShare = 5): string {
	if (eligible === 0) return "none eligible yet";
	if (eligible === null || count === null) return "unknown";
	const base = `${count} of ${eligible}`;
	return eligible >= minimumForShare ? `${base} (${Math.round((count / eligible) * 100)}%)` : base;
}
