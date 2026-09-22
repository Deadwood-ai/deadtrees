import { useId, type KeyboardEvent } from "react";
import { Tooltip } from "antd";

export interface TrendSeries {
	key: string;
	label: string;
	color: string;
}

export interface TrendBucket {
	key: string;
	label: string;
	shortLabel: string;
	complete: boolean;
	/** Population behind the bucket: a number, null when it should exist but is unknown, undefined when not applicable. */
	n?: number | null;
	values: Record<string, number | null>;
}

export interface ReferenceLine {
	value: number;
	label: string;
}

type FactoryTrendChartProps = {
	buckets: TrendBucket[];
	series: TrendSeries[];
	/** Stacked bars for one population split by outcome, grouped bars for separate event counts, points for percentiles. */
	kind: "stacked" | "grouped" | "points";
	ariaLabel: string;
	format: (value: number) => string;
	selectedKey?: string | null;
	onSelect?: (key: string | null) => void;
	referenceLines?: ReferenceLine[];
	height?: number;
};

const WIDTH = 720;
const MAX_AXIS_LABELS = 6;
const PAD = { top: 12, right: 12, bottom: 34, left: 68 };

const niceMax = (value: number): number => {
	if (value <= 0) return 1;
	const magnitude = 10 ** Math.floor(Math.log10(value));
	const scaled = value / magnitude;
	const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
	return step * magnitude;
};

const describeBucket = (bucket: TrendBucket, series: TrendSeries[], format: (value: number) => string) =>
	`${bucket.label}${bucket.complete ? "" : ", partial period"}: ${series
		.map((item) => {
			const value = bucket.values[item.key];
			return `${item.label} ${value === null || value === undefined ? "unknown" : format(value)}`;
		})
		.join(", ")}${typeof bucket.n === "number" ? `, n ${bucket.n}` : bucket.n === null ? ", n unknown" : ""}`;

/**
 * Compact SVG chart where every bucket is a real button, so selection works with
 * a keyboard and screen readers hear the numbers. Missing values stay gaps.
 */
export default function FactoryTrendChart({
	buckets,
	series,
	kind,
	ariaLabel,
	format,
	selectedKey = null,
	onSelect,
	referenceLines = [],
	height = 220,
}: FactoryTrendChartProps) {
	const patternId = useId();
	const innerWidth = WIDTH - PAD.left - PAD.right;
	const innerHeight = height - PAD.top - PAD.bottom;
	const slot = buckets.length ? innerWidth / buckets.length : innerWidth;

	const totals = buckets.map((bucket) => {
		if (kind === "stacked") {
			return series.reduce((sum, item) => sum + (bucket.values[item.key] ?? 0), 0);
		}
		return Math.max(0, ...series.map((item) => bucket.values[item.key] ?? 0));
	});
	const maxValue = niceMax(Math.max(...totals, ...referenceLines.map((line) => line.value), 0));
	const y = (value: number) => PAD.top + innerHeight - (value / maxValue) * innerHeight;
	const ticks = [0, 0.5, 1].map((fraction) => fraction * maxValue);

	// Show at most six axis labels; every bucket keeps its full label for tooltips and screen readers.
	const labelEvery = Math.max(1, Math.ceil(buckets.length / MAX_AXIS_LABELS));
	const activate = (key: string) => onSelect?.(selectedKey === key ? null : key);
	const onKey = (event: KeyboardEvent<SVGGElement>, key: string) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			activate(key);
		}
	};

	return (
		<figure className="m-0">
			<div className="overflow-x-auto">
				<svg viewBox={`0 0 ${WIDTH} ${height}`} className="h-auto w-full" role="group" aria-label={ariaLabel}>
				<defs>
					<pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
						<line x1="0" y1="0" x2="0" y2="6" stroke="#9CA3AF" strokeWidth="2" />
					</pattern>
				</defs>
				{ticks.map((tick) => (
					<g key={tick}>
						<line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} stroke="#E5E7EB" strokeWidth="1" />
						<text x={PAD.left - 6} y={y(tick) + 4} textAnchor="end" fontSize="11" fill="#6B7280">
							{format(tick)}
						</text>
					</g>
				))}
				{referenceLines.map((line) => (
					<g key={line.label}>
						<line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(line.value)} y2={y(line.value)} stroke="#AE5920" strokeDasharray="4 4" strokeWidth="1" />
						<text x={WIDTH - PAD.right} y={y(line.value) - 4} textAnchor="end" fontSize="10" fill="#AE5920">
							{line.label}
						</text>
					</g>
				))}
				{kind === "points" &&
					series.map((item) => {
						// Join only neighbouring measured buckets, so an unknown interval stays a visible gap.
						const segments: string[][] = [[]];
						buckets.forEach((bucket, index) => {
							const value = bucket.values[item.key];
							if (value === null || value === undefined) {
								if (segments[segments.length - 1].length) segments.push([]);
								return;
							}
							segments[segments.length - 1].push(`${PAD.left + slot * index + slot / 2},${y(value)}`);
						});
						return segments
							.filter((segment) => segment.length > 1)
							.map((segment, segmentIndex) => (
								<polyline key={`${item.key}-${segmentIndex}`} points={segment.join(" ")} fill="none" stroke={item.color} strokeWidth="2" opacity="0.7" />
							));
					})}
				{buckets.map((bucket, index) => {
					const x0 = PAD.left + slot * index;
					const selected = selectedKey === bucket.key;
					const barWidth = Math.max(6, slot * 0.6);
					const barX = x0 + (slot - barWidth) / 2;
					const groupWidth = Math.max(3, (slot * 0.7) / Math.max(1, series.length));
					const groupX = x0 + (slot - groupWidth * series.length) / 2;
					let stackTop = 0;
					const anyUnknown = series.some((item) => bucket.values[item.key] === null || bucket.values[item.key] === undefined);
					const allUnknown = series.every((item) => bucket.values[item.key] === null || bucket.values[item.key] === undefined);
					const showUnknownMark = kind === "points" ? allUnknown : anyUnknown;
					return (
						<Tooltip key={bucket.key} title={describeBucket(bucket, series, format)}>
							<g
								role={onSelect ? "button" : "img"}
								tabIndex={onSelect ? 0 : undefined}
								aria-pressed={onSelect ? selected : undefined}
								aria-label={describeBucket(bucket, series, format)}
								data-testid={`trend-bucket-${bucket.key}`}
								className={onSelect ? "cursor-pointer focus:outline-none" : undefined}
								onClick={onSelect ? () => activate(bucket.key) : undefined}
								onKeyDown={onSelect ? (event) => onKey(event, bucket.key) : undefined}
							>
								<rect x={x0} y={PAD.top} width={slot} height={innerHeight} fill={selected ? "#EAFAF0" : "transparent"} stroke={selected ? "#1B5E35" : "none"} strokeWidth="1.5" rx="4" />
								{!bucket.complete && <rect x={x0 + 1} y={PAD.top} width={slot - 2} height={innerHeight} fill={`url(#${patternId})`} opacity="0.25" />}
								{kind === "stacked" &&
									series.map((item) => {
										const value = bucket.values[item.key];
										if (value === null || value === undefined || value <= 0) return null;
										const top = y(stackTop + value);
										const bottom = y(stackTop);
										stackTop += value;
										return <rect key={item.key} x={barX} y={top} width={barWidth} height={Math.max(1, bottom - top)} fill={item.color} rx="2" />;
									})}
								{kind === "grouped" &&
									series.map((item, seriesIndex) => {
										const value = bucket.values[item.key];
										if (value === null || value === undefined || value <= 0) return null;
										const top = y(value);
										return (
											<rect key={item.key} x={groupX + groupWidth * seriesIndex} y={top} width={Math.max(2, groupWidth - 1)} height={Math.max(1, y(0) - top)} fill={item.color} rx="1.5" />
										);
									})}
								{kind === "points" &&
									series.map((item) => {
										const value = bucket.values[item.key];
										if (value === null || value === undefined) return null;
										return <circle key={item.key} cx={x0 + slot / 2} cy={y(value)} r="4" fill={item.color} stroke="#fff" strokeWidth="1" />;
									})}
								{showUnknownMark && (
									<text x={x0 + slot / 2} y={PAD.top + innerHeight - 6} textAnchor="middle" fontSize="11" fill="#9CA3AF">
										?
									</text>
								)}
								{(index % labelEvery === 0 || selected) && (
									<text x={x0 + slot / 2} y={height - PAD.bottom + 14} textAnchor="middle" fontSize="11" fill={selected ? "#1B5E35" : "#374151"} fontWeight={selected ? 600 : 400}>
										{bucket.shortLabel}
									</text>
								)}
								{bucket.n !== undefined && (
									<text x={x0 + slot / 2} y={height - PAD.bottom + 27} textAnchor="middle" fontSize="10" fill="#9CA3AF">
										{bucket.n === null ? "n ?" : `n ${bucket.n}`}
									</text>
								)}
							</g>
						</Tooltip>
					);
				})}
				</svg>
			</div>
			<figcaption className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600">
				{series.map((item) => (
					<span key={item.key} className="inline-flex items-center gap-1">
						<span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: item.color }} aria-hidden />
						{item.label}
					</span>
				))}
				<span className="inline-flex items-center gap-1">
					<span className="inline-block h-2.5 w-2.5 rounded-sm bg-[repeating-linear-gradient(45deg,#9CA3AF_0_2px,transparent_2px_5px)]" aria-hidden />
					partial period
				</span>
				<span className="text-gray-400">? = not measured</span>
			</figcaption>
		</figure>
	);
}
