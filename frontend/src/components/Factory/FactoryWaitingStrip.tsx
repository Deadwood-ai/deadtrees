import { Skeleton, Tooltip, Typography } from "antd";
import { Link } from "react-router-dom";
import { factoryDatasetsPath, filtersFromRecord } from "./factoryFilters";
import { formatRelative, formatUtc, minutesSince } from "./factoryFormat";
import { EmptyNote, FactoryError, SectionCard, Unknown } from "./FactoryPrimitives";
import type { FactoryOperations, FactoryWaitingRow } from "./factoryTypes";

const { Text } = Typography;

const TITLES: Record<string, string> = {
	queued: "Queued",
	processing: "Processing",
	failed: "Failed",
	delivery: "Delivery problems",
	reports: "Open reports",
};

const TONES: Record<string, string> = {
	failed: "text-red-700",
	delivery: "text-amber-700",
	queued: "text-amber-700",
};

type FactoryWaitingStripProps = {
	operations: FactoryOperations | undefined;
	isLoading: boolean;
	error: unknown;
	onRetry: () => void;
	now: number;
};

/** Counts with the exact clock behind each age. The oldest group is a candidate for attention, not a proven constraint. */
export default function FactoryWaitingStrip({ operations, isLoading, error, onRetry, now }: FactoryWaitingStripProps) {
	const rows = operations?.waiting ?? [];
	const oldestKey = rows.reduce<{ key: string | null; minutes: number }>(
		(best, row) => {
			const minutes = minutesSince(row.oldest_at, now);
			return minutes !== null && minutes > best.minutes ? { key: row.key, minutes } : best;
		},
		{ key: null, minutes: -1 }
	).key;

	const renderRow = (row: FactoryWaitingRow) => {
		const filters = { ...filtersFromRecord(row.filters), sort: "attention" as const };
		const isOldest = row.key === oldestKey && rows.length > 1;
		const tone = row.count === 0 ? "text-gray-400" : (TONES[row.key] ?? "text-gray-900");
		return (
			<Link
				key={row.key}
				to={factoryDatasetsPath(filters)}
				className={`flex flex-col rounded-xl border p-3 text-inherit no-underline transition-colors hover:bg-white ${
					isOldest ? "border-amber-300 bg-amber-50/60" : "border-gray-100 bg-gray-50 hover:border-gray-300"
				}`}
				data-testid={`waiting-${row.key}`}
				aria-label={`${TITLES[row.key] ?? row.key}: ${row.count ?? "unknown"} datasets, open list ordered by attention`}
			>
				<span className="flex items-start justify-between gap-2">
					<span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{TITLES[row.key] ?? row.key}</span>
					{isOldest && (
						<Tooltip title="Longest-waiting group right now. A large or old backlog is a candidate for attention, not proof of a system constraint.">
							<span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-amber-800 ring-1 ring-amber-200">oldest</span>
						</Tooltip>
					)}
				</span>
				<span className={`mt-2 text-3xl font-semibold leading-none ${tone}`}>
					{row.count === null ? <Unknown reason="The read model returned no count." /> : row.count.toLocaleString()}
				</span>
				<span className="mt-2 text-xs text-gray-500">
					{row.age_label || "Oldest"}:{" "}
					{row.oldest_at ? (
						<Tooltip title={formatUtc(row.oldest_at)}>
							<span className="font-medium text-gray-700">{formatRelative(row.oldest_at, now)}</span>
						</Tooltip>
					) : row.count === 0 ? (
						<span>none</span>
					) : (
						<Unknown reason="No timestamp is tracked for this group." />
					)}
				</span>
			</Link>
		);
	};

	return (
		<SectionCard title="Waiting" testId="factory-waiting">
			{error && !operations ? (
				<FactoryError error={error} onRetry={onRetry} title="Could not load waiting counts" />
			) : isLoading || !operations ? (
				<Skeleton active paragraph={{ rows: 2 }} />
			) : rows.length === 0 ? (
				<EmptyNote>The read model returned no waiting groups.</EmptyNote>
			) : (
				<div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">{rows.map(renderRow)}</div>
			)}
			<Text type="secondary" className="mt-3 block text-xs">
				Current unarchived datasets. Each age names its own clock, not time in a stage. Groups overlap with the attention list above; each opens the
				explorer ordered by attention.
			</Text>
		</SectionCard>
	);
}
