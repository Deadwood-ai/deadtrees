import { useState } from "react";
import { Segmented, Skeleton, Typography } from "antd";
import { Link } from "react-router-dom";
import { factoryDatasetsPath } from "./factoryFilters";
import { formatUtc } from "./factoryFormat";
import { TREND_COLORS, formatCount, formatGib, formatHours, toTrendBuckets } from "./factoryTrends";
import FactoryTrendChart from "./FactoryTrendChart";
import { EmptyNote, FactoryError, SectionCard, Unknown } from "./FactoryPrimitives";
import type { FactoryFilters, FactoryMetricFilter, FactoryTrendPoint, FactoryTrends } from "./factoryTypes";

const { Text } = Typography;

type FactoryOutcomesProps = {
	trends: FactoryTrends | undefined;
	isLoading: boolean;
	error: unknown;
	onRetry: () => void;
	selectedKey: string | null;
	onSelect: (key: string | null) => void;
};

const Value = ({ value, format = formatCount, reason }: { value: number | null | undefined; format?: (value: number) => string; reason?: string }) =>
	value === null || value === undefined ? (
		<Unknown reason={reason ?? "Not measured."} />
	) : (
		<span className="font-semibold text-gray-900">{format(value)}</span>
	);

/** Explorer link for a ledger metric, optionally bounded to a bucket. Ledger populations include archived datasets. */
const metricPath = (trends: FactoryTrends, metric: FactoryMetricFilter, point?: FactoryTrendPoint) => {
	const filters: FactoryFilters = { metric, archived: "all" };
	if (trends.workflow !== "all") filters.workflow = trends.workflow;
	if (trends.size !== "all") filters.size = trends.size;
	if (point) {
		filters.metric_after = point.start;
		filters.metric_before = point.end;
	}
	return factoryDatasetsPath(filters);
};

function SelectedBucketPanel({ trends, point }: { trends: FactoryTrends; point: FactoryTrendPoint }) {
	const label = trends.interval === "day" ? "day" : "week";
	const unmeasured = "Before measurement started, so not measured.";
	return (
		<div className="mt-3 rounded-xl border border-[#1B5E35]/30 bg-[#EAFAF0]/60 p-3 text-sm" data-testid="factory-selected-bucket">
			<div className="mb-2 flex flex-wrap items-center gap-2 font-semibold text-gray-900">
				Selected {label}: {formatUtc(point.start)} to {formatUtc(point.end)}
				{point.partial && (
					<span className="rounded-full bg-white px-2 text-xs font-normal text-gray-600 ring-1 ring-gray-200" title="The current interval, or measurement started inside it">
						partial period
					</span>
				)}
				{!point.measured && <span className="rounded-full bg-white px-2 text-xs font-normal text-gray-600 ring-1 ring-gray-200">before measurement</span>}
			</div>
			<div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
				<span>
					Uploads completed{" "}
					<Link to={metricPath(trends, "uploaded", point)}>
						<Value value={point.uploaded} reason={unmeasured} />
					</Link>
				</span>
				<span>
					First complete results{" "}
					<Link to={metricPath(trends, "first_ready", point)}>
						<Value value={point.first_ready} reason={unmeasured} />
					</Link>
				</span>
				<span>
					Upload to result p50 <Value value={point.lead_p50_hours} format={formatHours} reason={unmeasured} /> · p90{" "}
					<Value value={point.lead_p90_hours} format={formatHours} reason={unmeasured} />
					{point.lead_samples !== null && <span className="text-gray-500"> · n {point.lead_samples}</span>}
				</span>
				<span>
					Failure episodes{" "}
					<Link to={metricPath(trends, "failures", point)}>
						<Value value={point.failures} reason={unmeasured} />
					</Link>{" "}
					· recovered{" "}
					<Link to={metricPath(trends, "recovered", point)}>
						<Value value={point.recovered} reason={unmeasured} />
					</Link>
				</span>
				<span>
					Recovery p50 <Value value={point.recovery_p50_hours} format={formatHours} reason={unmeasured} /> · p90{" "}
					<Value value={point.recovery_p90_hours} format={formatHours} reason={unmeasured} />
				</span>
				<span>
					Input with a first result <Value value={point.completed_input_gib} format={formatGib} reason="No measured size in this interval." />
					{point.volume_samples !== null && <span className="text-gray-500"> · from {point.volume_samples} datasets</span>}
				</span>
				<span>
					Registered datasets{" "}
					<Link to={metricPath(trends, "registered", point)}>
						<Value value={point.registered} />
					</Link>
				</span>
				<span>
					Recorded completions{" "}
					<Link to={metricPath(trends, "recorded_completed", point)}>
						<Value value={point.recorded_completed} />
					</Link>{" "}
					· failures{" "}
					<Link to={metricPath(trends, "recorded_failed", point)}>
						<Value value={point.recorded_failed} />
					</Link>
				</span>
				<span>
					Completions with a search-indexing task{" "}
					<Link to={metricPath(trends, "recorded_embedding_completed", point)}>
						<Value value={point.recorded_embedding_completed} />
					</Link>
				</span>
			</div>
			<Text type="secondary" className="mt-2 block text-xs">
				Links open the datasets behind each number. Failure and recovery counts are episodes; the list shows distinct datasets.
			</Text>
		</div>
	);
}

function SummaryStrip({ trends }: { trends: FactoryTrends }) {
	const summary = trends.summary;
	if (!summary) return <EmptyNote>The ledger returned no summary.</EmptyNote>;
	const pending = summary.waiting !== null && summary.failed !== null ? Math.max(0, summary.waiting - summary.failed) : null;
	return (
		<dl className="m-0 grid grid-cols-2 gap-3 text-sm md:grid-cols-3 xl:grid-cols-6" data-testid="factory-measured-summary">
			<div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
				<dt className="text-xs uppercase tracking-wide text-gray-500">Tracked uploads</dt>
				<dd className="m-0 mt-1 text-2xl font-semibold text-gray-900">
					<Value value={summary.tracked_submissions} />
				</dd>
			</div>
			<div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
				<dt className="text-xs uppercase tracking-wide text-gray-500">First complete results</dt>
				<dd className="m-0 mt-1 text-2xl font-semibold text-gray-900">
					<Link to={metricPath(trends, "first_ready")}>
						<Value value={summary.first_ready} />
					</Link>
				</dd>
			</div>
			<div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
				<dt className="text-xs uppercase tracking-wide text-gray-500">Still waiting</dt>
				<dd className="m-0 mt-1 text-2xl font-semibold text-gray-900">
					<Link to={metricPath(trends, "waiting")}>
						<Value value={summary.waiting} />
					</Link>
				</dd>
				<dd className="m-0 text-xs text-gray-500">
					{pending !== null ? `${pending} pending` : "pending unknown"} ·{" "}
					<Link to={metricPath(trends, "failed_submission")}>{summary.failed ?? "unknown"} failed</Link> ·{" "}
					{summary.waiting_contributors ?? "unknown"} contributor{summary.waiting_contributors === 1 ? "" : "s"}
				</dd>
			</div>
			<div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
				<dt className="text-xs uppercase tracking-wide text-gray-500">Oldest wait</dt>
				<dd className="m-0 mt-1 text-2xl font-semibold text-gray-900">
					<Value value={summary.oldest_wait_hours} format={formatHours} reason="Nothing is waiting, or the wait is not measured." />
				</dd>
				<dd className="m-0 text-xs text-gray-500">
					<Link to={metricPath(trends, "overdue")}>{summary.overdue ?? "unknown"} overdue</Link> (GeoTIFF under 1 GiB, over 2 h; a soft warning)
				</dd>
			</div>
			<div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
				<dt className="text-xs uppercase tracking-wide text-gray-500">Unresolved failures</dt>
				<dd className="m-0 mt-1 text-2xl font-semibold text-gray-900">
					<Link to={metricPath(trends, "unresolved_failure")}>
						<Value value={summary.unresolved_failures} />
					</Link>
				</dd>
				<dd className="m-0 text-xs text-gray-500">
					{summary.recovered ?? "unknown"} recovered · recovery p50{" "}
					{summary.recovery_p50_hours === null ? "unknown" : formatHours(summary.recovery_p50_hours)}
				</dd>
			</div>
			<div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
				<dt className="text-xs uppercase tracking-wide text-gray-500">Input with a result</dt>
				<dd className="m-0 mt-1 text-2xl font-semibold text-gray-900">
					<Value value={summary.completed_input_gib} format={formatGib} reason="No result has a measured upload size yet." />
				</dd>
				<dd className="m-0 text-xs text-gray-500">
					{summary.volume_samples ?? "unknown"} measured · {summary.missing_volume ?? "unknown"} without a size
				</dd>
			</div>
		</dl>
	);
}

/** Measured pipeline outcomes from the prospective ledger, keyed by event time. */
export default function FactoryOutcomes({ trends, isLoading, error, onRetry, selectedKey, onSelect }: FactoryOutcomesProps) {
	const [failureView, setFailureView] = useState<"counts" | "duration">("counts");
	if (error && !trends) {
		return (
			<SectionCard title="Uploads and complete results" testId="factory-outcomes">
				<FactoryError error={error} onRetry={onRetry} title="Could not load measured outcomes" />
			</SectionCard>
		);
	}
	if (isLoading || !trends) {
		return (
			<SectionCard title="Uploads and complete results" testId="factory-outcomes">
				<Skeleton active paragraph={{ rows: 6 }} />
			</SectionCard>
		);
	}

	const points = trends.series;
	const selected = points.find((point) => point.start === selectedKey) ?? null;
	const trackingNote = trends.tracking_since
		? `Measured since ${formatUtc(trends.tracking_since)}; earlier intervals show “?” because nothing was reconstructed.`
		: "Measurement has not started yet.";
	const legacy = trends.summary?.legacy_uploaded ?? null;

	const throughput = toTrendBuckets(points, trends.interval, (point) => ({
		values: { uploaded: point.uploaded, first_ready: point.first_ready },
	}));
	const latency = toTrendBuckets(points, trends.interval, (point) => ({
		n: point.lead_samples,
		values: { p50: point.lead_p50_hours, p90: point.lead_p90_hours },
	}));
	const failures = toTrendBuckets(points, trends.interval, (point) => ({
		values: { failures: point.failures, recovered: point.recovered },
	}));
	const recoveryTime = toTrendBuckets(points, trends.interval, (point) => ({
		n: point.recovered,
		values: { p50: point.recovery_p50_hours, p90: point.recovery_p90_hours },
	}));
	const calibrated = trends.workflow === "geotiff" && trends.size === "small";
	const volume = toTrendBuckets(points, trends.interval, (point) => ({
		n: point.volume_samples,
		values: { input: point.completed_input_gib },
	}));

	return (
		<div className="space-y-6" data-testid="factory-outcomes">
			<SectionCard title="Uploads and complete results" testId="factory-outcomes-results">
				<Text type="secondary" className="mb-3 block text-xs">
					Whole tracked population since measurement started, regardless of the plotted window. {trackingNote}
					{legacy !== null && legacy > 0 && <> {legacy} older uploads predate measurement and are excluded from timing.</>}
				</Text>
				<SummaryStrip trends={trends} />
				<Text type="secondary" className="mb-2 mt-4 block text-xs">
					Per interval, by when each event happened: uploads that completed, and datasets that reached their first complete result. The two
					bars are separate events, not a success rate. Select an interval to open its datasets.
				</Text>
				{points.length === 0 ? (
					<EmptyNote>No intervals were returned.</EmptyNote>
				) : (
					<FactoryTrendChart
						kind="grouped"
						ariaLabel="Uploads completed and first complete results per interval"
						buckets={throughput}
						series={[
							{ key: "uploaded", label: "Uploads completed", color: TREND_COLORS.uploaded },
							{ key: "first_ready", label: "First complete results", color: TREND_COLORS.ready },
						]}
						format={formatCount}
						selectedKey={selectedKey}
						onSelect={onSelect}
					/>
				)}
				{selected && <SelectedBucketPanel trends={trends} point={selected} />}
			</SectionCard>

			<div className="grid gap-6 xl:grid-cols-2">
				<SectionCard title="Time to first complete result" testId="factory-outcomes-timing">
					<Text type="secondary" className="mb-2 block text-xs">
						Completed upload to first complete result, grouped by when the result arrived, with n completions. This is the end-to-end wait a
						contributor experiences; claim age in “Active claims” is a different clock.{" "}
						{calibrated
							? "The dashed 1 h target and 2 h bound are the documented guidance for GeoTIFF uploads under 1 GiB, not a pass mark."
							: "The documented 1 h target and 2 h bound apply to GeoTIFF uploads under 1 GiB; choose that workflow and size to see them. Targets for larger or raw-image uploads still need calibration."}
					</Text>
					<FactoryTrendChart
						kind="points"
						ariaLabel="Upload to first complete result, median and 90th percentile"
						buckets={latency}
						series={[
							{ key: "p50", label: "p50", color: TREND_COLORS.p50 },
							{ key: "p90", label: "p90", color: TREND_COLORS.p90 },
						]}
						format={formatHours}
						referenceLines={
							calibrated
								? [
										{ value: 1, label: "1 h target" },
										{ value: 2, label: "2 h healthy" },
									]
								: []
						}
						selectedKey={selectedKey}
						onSelect={onSelect}
					/>
					{trends.summary && (
						<Text className="mt-2 block text-sm text-gray-600">
							All tracked completions: p50{" "}
							{trends.summary.lead_p50_hours === null ? "unknown" : formatHours(trends.summary.lead_p50_hours)} · p90{" "}
							{trends.summary.lead_p90_hours === null ? "unknown" : formatHours(trends.summary.lead_p90_hours)} · n {trends.summary.lead_samples ?? "unknown"}.
							Still waiting is shown above, never inside these percentiles.
						</Text>
					)}
				</SectionCard>

				<SectionCard
					title="Failures and recovery"
					testId="factory-outcomes-failures"
					extra={
						<Segmented<"counts" | "duration">
							size="small"
							value={failureView}
							onChange={setFailureView}
							options={[
								{ label: "Counts", value: "counts" },
								{ label: "Recovery time", value: "duration" },
							]}
							aria-label="Failure chart view"
						/>
					}
				>
					<Text type="secondary" className="mb-2 block text-xs">
						{failureView === "counts"
							? "Failure episodes recorded for tracked uploads, and episodes that later reached a complete result, each by when it happened. A dataset can have several episodes; the explorer lists distinct datasets."
							: "Time from a recorded failure to a complete result, for episodes that recovered, grouped by when they recovered, with n recovered episodes."}
					</Text>
					{failureView === "counts" ? (
						<FactoryTrendChart
							kind="grouped"
							ariaLabel="Failure episodes and recoveries per interval"
							buckets={failures}
							series={[
								{ key: "failures", label: "Failure episodes", color: TREND_COLORS.failed },
								{ key: "recovered", label: "Recovered", color: TREND_COLORS.recovered },
							]}
							format={formatCount}
							selectedKey={selectedKey}
							onSelect={onSelect}
						/>
					) : (
						<FactoryTrendChart
							kind="points"
							ariaLabel="Recovery time, median and 90th percentile per interval"
							buckets={recoveryTime}
							series={[
								{ key: "p50", label: "p50", color: TREND_COLORS.p50 },
								{ key: "p90", label: "p90", color: TREND_COLORS.p90 },
							]}
							format={formatHours}
							selectedKey={selectedKey}
							onSelect={onSelect}
						/>
					)}
					{trends.summary && (
						<Text className="mt-2 block text-sm text-gray-600">
							Unresolved now:{" "}
							<Link to={metricPath(trends, "unresolved_failure")}>{trends.summary.unresolved_failures ?? "unknown"}</Link> · recovery p50{" "}
							{trends.summary.recovery_p50_hours === null ? "unknown" : formatHours(trends.summary.recovery_p50_hours)} · p90{" "}
							{trends.summary.recovery_p90_hours === null ? "unknown" : formatHours(trends.summary.recovery_p90_hours)}
						</Text>
					)}
				</SectionCard>
			</div>

			<SectionCard title="Input that reached a complete result" testId="factory-outcomes-input">
				<Text type="secondary" className="mb-2 block text-xs">
					Uploaded bytes measured on the server, counted once when the dataset reaches its first complete result. Reruns, retries and search
					indexing add nothing. Datasets without a measured size are counted separately, not as zero.
				</Text>
				<FactoryTrendChart
					kind="stacked"
					ariaLabel="Input volume that reached a first complete result, in GiB"
					buckets={volume}
					series={[{ key: "input", label: "GiB with a first result", color: TREND_COLORS.input }]}
					format={formatGib}
					selectedKey={selectedKey}
					onSelect={onSelect}
					height={180}
				/>
			</SectionCard>
		</div>
	);
}
