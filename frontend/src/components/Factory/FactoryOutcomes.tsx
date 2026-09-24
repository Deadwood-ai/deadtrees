import { useState } from "react";
import { Segmented, Skeleton, Typography } from "antd";
import { Link } from "react-router-dom";
import { factoryDatasetsPath } from "./factoryFilters";
import { formatUtc } from "./factoryFormat";
import { TREND_COLORS, evidenceNote, formatCount, formatGib, formatHours, toTrendBuckets } from "./factoryTrends";
import FactoryTrendChart, { type TrendMarker } from "./FactoryTrendChart";
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

const NO_EVIDENCE = "Before the earliest retained evidence, so unknown.";

const Value = ({ value, format = formatCount, reason = NO_EVIDENCE }: { value: number | null | undefined; format?: (value: number) => string; reason?: string }) =>
	value === null || value === undefined ? <Unknown reason={reason} /> : <span className="font-semibold text-gray-900">{format(value)}</span>;

/** Explorer link for an evidence metric, optionally bounded to a bucket. Evidence includes archived datasets. */
const metricPath = (trends: FactoryTrends, metric: FactoryMetricFilter, point?: FactoryTrendPoint) => {
	const filters: FactoryFilters = { metric, archived: point ? "all" : "no" };
	if (trends.workflow !== "all") filters.workflow = trends.workflow;
	if (trends.size !== "all") filters.size = trends.size;
	if (point) {
		filters.metric_after = point.start;
		filters.metric_before = point.end;
	}
	return factoryDatasetsPath(filters);
};

const sum = (values: (number | null)[]) => (values.some((value) => value !== null) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null);

/** Marks the bucket where direct measurement starts, when it falls inside the plotted window. */
const measuredFrom = (points: FactoryTrendPoint[], since: string | null): TrendMarker | null => {
	if (!since) return null;
	const at = new Date(since).getTime();
	const point = points.find((item) => new Date(item.start).getTime() <= at && at < new Date(item.end).getTime());
	return point && point !== points[0] ? { key: point.start, label: "measured →" } : null;
};

function Note({ total, measured }: { total: number | null; measured: number | null }) {
	const note = evidenceNote(total, measured);
	return note ? <span className="text-gray-500"> ({note})</span> : null;
}

function SelectedBucketPanel({ trends, point }: { trends: FactoryTrends; point: FactoryTrendPoint }) {
	const failures = point.failures_first_result === null || point.failures_other === null ? null : point.failures_first_result + point.failures_other;
	return (
		<div className="mt-3 rounded-xl border border-[#1B5E35]/30 bg-[#EAFAF0]/60 p-3 text-sm" data-testid="factory-selected-bucket">
			<div className="mb-2 flex flex-wrap items-center gap-2 font-semibold text-gray-900">
				Selected {trends.interval}: {formatUtc(point.start)} to {formatUtc(point.end)}
				{point.partial && (
					<span className="rounded-full bg-white px-2 text-xs font-normal text-gray-600 ring-1 ring-gray-200" title="The current interval, or retained evidence starts inside it">
						partial period
					</span>
				)}
			</div>
			<div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
				<span>
					Uploads{" "}
					<Link to={metricPath(trends, "uploaded", point)}>
						<Value value={point.uploaded} />
					</Link>
					<Note total={point.uploaded} measured={point.uploaded_measured} />
				</span>
				<span>
					First complete results{" "}
					<Link to={metricPath(trends, "first_ready", point)}>
						<Value value={point.first_ready} />
					</Link>
					<Note total={point.first_ready} measured={point.first_ready_measured} />
				</span>
				<span>
					Upload to first result p50 <Value value={point.lead_p50_hours} format={formatHours} reason="No first result in this period." /> · p90{" "}
					<Value value={point.lead_p90_hours} format={formatHours} reason="No first result in this period." />
				</span>
				<span>
					Failures{" "}
					<Link to={metricPath(trends, "failures", point)}>
						<Value value={failures} />
					</Link>
					{" · "}
					<Link to={metricPath(trends, "first_result_failures", point)}>
						<Value value={point.failures_first_result} />
					</Link>{" "}
					before a first result
					<Note total={failures} measured={point.failures_measured} />
				</span>
				<span>
					Complete again{" "}
					<Link to={metricPath(trends, "recovered", point)}>
						<Value value={point.recovered} />
					</Link>{" "}
					· p50 <Value value={point.recovery_p50_hours} format={formatHours} reason="No failure with a known start ended in this period." />
					<Note total={point.recovered} measured={point.recovered_measured} />
				</span>
				<span>
					Input with a first result <Value value={point.completed_input_gib} format={formatGib} reason="No first result with a known size in this period." />
					{point.volume_samples !== null && point.first_ready !== null && (
						<span className="text-gray-500">
							{" "}
							· {point.volume_samples} of {point.first_ready} sizes known
						</span>
					)}
				</span>
			</div>
			<Text type="secondary" className="mt-2 block text-xs">
				Links open the datasets behind each number, including archived ones. Failure counts are episodes; the list shows distinct datasets.
			</Text>
		</div>
	);
}

function SummaryStrip({ trends }: { trends: FactoryTrends }) {
	const summary = trends.summary;
	if (!summary) return <EmptyNote>No current summary was returned.</EmptyNote>;
	const pending = summary.waiting !== null && summary.waiting_failed !== null ? Math.max(0, summary.waiting - summary.waiting_failed) : null;
	const known = trends.series;
	const results = sum(known.map((point) => point.first_ready));
	const uploads = sum(known.map((point) => point.uploaded));
	return (
		<dl className="m-0 grid grid-cols-2 gap-3 text-sm xl:grid-cols-4" data-testid="factory-outcome-summary">
			<div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
				<dt className="text-xs uppercase tracking-wide text-gray-500">Waiting for a first result</dt>
				<dd className="m-0 mt-1 text-2xl font-semibold text-gray-900">
					<Link to={metricPath(trends, "waiting")}>
						<Value value={summary.waiting} />
					</Link>
				</dd>
				<dd className="m-0 text-xs text-gray-500">
					<Link to={metricPath(trends, "failed_submission")}>{summary.waiting_failed ?? "unknown"} failed</Link> · {pending ?? "unknown"} pending ·{" "}
					{summary.waiting_contributors ?? "unknown"} contributor{summary.waiting_contributors === 1 ? "" : "s"}
				</dd>
			</div>
			<div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
				<dt className="text-xs uppercase tracking-wide text-gray-500">Longest wait</dt>
				<dd className="m-0 mt-1 text-2xl font-semibold text-gray-900">
					<Value value={summary.oldest_wait_hours} format={formatHours} reason="Nothing is waiting." />
				</dd>
				<dd className="m-0 text-xs text-gray-500">since upload, still without a first result</dd>
			</div>
			<div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
				<dt className="text-xs uppercase tracking-wide text-gray-500">Failures still open</dt>
				<dd className="m-0 mt-1 text-2xl font-semibold text-gray-900">
					<Link to={metricPath(trends, "unresolved_failure")}>
						<Value value={summary.unresolved_failures} />
					</Link>
				</dd>
				<dd className="m-0 text-xs text-gray-500">
					{summary.unresolved_first_result ?? "unknown"} never had a result · oldest{" "}
					{summary.oldest_unresolved_hours === null ? "start unknown" : formatHours(summary.oldest_unresolved_hours)}
				</dd>
			</div>
			<div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
				<dt className="text-xs uppercase tracking-wide text-gray-500">First results in this chart</dt>
				<dd className="m-0 mt-1 text-2xl font-semibold text-gray-900">
					<Value value={results} />
				</dd>
				<dd className="m-0 text-xs text-gray-500">from {uploads === null ? "unknown" : formatCount(uploads)} uploads in the same periods</dd>
			</div>
		</dl>
	);
}

/**
 * Upload-to-result outcomes by event time. Directly measured facts where they
 * exist, reconstructed from retained upload and processor logs before that.
 */
export default function FactoryOutcomes({ trends, isLoading, error, onRetry, selectedKey, onSelect }: FactoryOutcomesProps) {
	const [failureView, setFailureView] = useState<"counts" | "duration">("counts");
	if (error && !trends) {
		return (
			<SectionCard title="Uploads and complete results" testId="factory-outcomes">
				<FactoryError error={error} onRetry={onRetry} title="Could not load outcomes" />
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
	const resultsMarker = measuredFrom(points, trends.tracking_since);
	const failuresMarker = measuredFrom(points, trends.failures_tracking_since);
	const unrecorded = trends.summary?.unrecorded_results ?? null;

	const throughput = toTrendBuckets(points, trends.interval, (point) => ({
		note: [evidenceNote(point.uploaded, point.uploaded_measured) && `uploads ${evidenceNote(point.uploaded, point.uploaded_measured)}`, evidenceNote(point.first_ready, point.first_ready_measured) && `results ${evidenceNote(point.first_ready, point.first_ready_measured)}`]
			.filter(Boolean)
			.join("; "),
		values: { uploaded: point.uploaded, first_ready: point.first_ready },
	}));
	const latency = toTrendBuckets(points, trends.interval, (point) => ({
		n: point.first_ready,
		note: evidenceNote(point.first_ready, point.first_ready_measured),
		values: { p50: point.lead_p50_hours, p90: point.lead_p90_hours },
	}));
	const failures = toTrendBuckets(points, trends.interval, (point) => ({
		note: evidenceNote(point.failures_first_result === null ? null : point.failures_first_result + (point.failures_other ?? 0), point.failures_measured),
		values: { first_result: point.failures_first_result, other: point.failures_other, recovered: point.recovered },
	}));
	const recoveryTime = toTrendBuckets(points, trends.interval, (point) => ({
		n: point.recovery_samples,
		note: evidenceNote(point.recovered, point.recovered_measured),
		values: { p50: point.recovery_p50_hours, p90: point.recovery_p90_hours },
	}));
	const volume = toTrendBuckets(points, trends.interval, (point) => ({
		n: point.volume_samples,
		note: evidenceNote(point.first_ready, point.first_ready_measured),
		values: { input: point.completed_input_gib },
	}));
	const calibrated = trends.workflow === "geotiff" && trends.size === "small";

	return (
		<div className="space-y-6" data-testid="factory-outcomes">
			<SectionCard title="Uploads and complete results" testId="factory-outcomes-results">
				<Text type="secondary" className="mb-3 block text-xs" data-testid="factory-outcome-evidence">
					{trends.tracking_since ? <>Measured directly for uploads registered since {formatUtc(trends.tracking_since)}. </> : <>Direct measurement has not started yet. </>}
					{trends.upload_since || trends.run_since ? (
						<>
							Earlier periods are reconstructed from retained upload logs (from {formatUtc(trends.upload_since)}) and processor logs (from{" "}
							{formatUtc(trends.run_since)}).{" "}
						</>
					) : (
						<>No retained upload or processor logs were found. </>
					)}
					“?” marks periods without evidence. Hover a period to see which evidence it rests on.
					{unrecorded !== null && unrecorded > 0 && <> {unrecorded} complete uploads have no retained time for their first result.</>}
				</Text>
				<SummaryStrip trends={trends} />
				<Text type="secondary" className="mb-2 mt-4 block text-xs">
					Per period, by when each event happened: uploads, and datasets that reached their first complete result (counted once, never for
					reruns). The two bars are separate events, not a success rate. Select a period to open its datasets.
				</Text>
				{points.length === 0 ? (
					<EmptyNote>No periods were returned.</EmptyNote>
				) : (
					<FactoryTrendChart
						kind="grouped"
						ariaLabel="Uploads and first complete results per period"
						buckets={throughput}
						series={[
							{ key: "uploaded", label: "Uploads", color: TREND_COLORS.uploaded },
							{ key: "first_ready", label: "First complete results", color: TREND_COLORS.ready },
						]}
						format={formatCount}
						marker={resultsMarker}
						selectedKey={selectedKey}
						onSelect={onSelect}
					/>
				)}
				{selected && <SelectedBucketPanel trends={trends} point={selected} />}
			</SectionCard>

			<div className="grid gap-6 xl:grid-cols-2">
				<SectionCard title="Time to first complete result" testId="factory-outcomes-timing">
					<Text type="secondary" className="mb-2 block text-xs">
						Upload to first complete result, grouped by when the result arrived, with n results. It includes queueing, every stage and any
						recovery, so it is the wait a contributor experiences. Uploads still waiting are counted above, never inside these percentiles.{" "}
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
						marker={resultsMarker}
						selectedKey={selectedKey}
						onSelect={onSelect}
					/>
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
								{ label: "Time to complete again", value: "duration" },
							]}
							aria-label="Failure chart view"
						/>
					}
				>
					<Text type="secondary" className="mb-2 block text-xs">
						{failureView === "counts"
							? "Failure episodes by when they started, split by whether the contributor was still waiting for a first result, and episodes that ended because the dataset was complete again. Measured episodes end at full readiness; reconstructed ones when a later run proved the failed stage again and every readiness stage is proven. A successful retry of other stages never counts. Retries of the same broken dataset are one episode."
							: "Time from the start of a failure until the dataset was complete again, grouped by when that happened, with n episodes whose start is known."}
					</Text>
					{failureView === "counts" ? (
						<FactoryTrendChart
							kind="grouped"
							ariaLabel="Failure episodes and datasets complete again per period"
							buckets={failures}
							series={[
								{ key: "first_result", label: "Failed before a first result", color: TREND_COLORS.failed },
								{ key: "other", label: "Failed rerun or older upload", color: TREND_COLORS.recordedFailed },
								{ key: "recovered", label: "Complete again", color: TREND_COLORS.recovered },
							]}
							format={formatCount}
							marker={failuresMarker}
							selectedKey={selectedKey}
							onSelect={onSelect}
						/>
					) : (
						<FactoryTrendChart
							kind="points"
							ariaLabel="Time until complete again, median and 90th percentile per period"
							buckets={recoveryTime}
							series={[
								{ key: "p50", label: "p50", color: TREND_COLORS.p50 },
								{ key: "p90", label: "p90", color: TREND_COLORS.p90 },
							]}
							format={formatHours}
							marker={failuresMarker}
							selectedKey={selectedKey}
							onSelect={onSelect}
						/>
					)}
					{trends.summary && (
						<Text className="mt-2 block text-sm text-gray-600">
							Open now: <Link to={metricPath(trends, "unresolved_failure")}>{trends.summary.unresolved_failures ?? "unknown"}</Link>, of which{" "}
							{trends.summary.unresolved_first_result ?? "unknown"} never had a result.
						</Text>
					)}
				</SectionCard>
			</div>

			<SectionCard title="Input that reached a complete result" testId="factory-outcomes-input">
				<Text type="secondary" className="mb-2 block text-xs">
					Original uploaded size, measured on the server or taken from the upload log, counted once when the dataset reaches its first complete
					result. Reruns and search indexing add nothing. n is the number of results with a known size; unknown sizes are left out, not counted
					as zero.
				</Text>
				<FactoryTrendChart
					kind="stacked"
					ariaLabel="Input volume that reached a first complete result, in GiB"
					buckets={volume}
					series={[{ key: "input", label: "GiB with a first result", color: TREND_COLORS.input }]}
					format={formatGib}
					marker={resultsMarker}
					selectedKey={selectedKey}
					onSelect={onSelect}
					height={180}
				/>
			</SectionCard>
		</div>
	);
}
