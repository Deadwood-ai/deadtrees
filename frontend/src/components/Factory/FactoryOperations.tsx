import { useState } from "react";
import { Alert, Collapse, Segmented, Select, Skeleton, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link, useSearchParams } from "react-router-dom";
import { isFactoryPermissionError, useFactoryJourney, useFactoryOperations, useFactoryOverview, useFactoryTrends } from "../../hooks/useFactory";
import { factoryDatasetsPath } from "./factoryFilters";
import { formatDuration, formatTaskTypes, isSilentClaim, minutesSince } from "./factoryFormat";
import FactoryAttentionList from "./FactoryAttentionList";
import FactoryJourneyOutcomes from "./FactoryJourneyOutcomes";
import FactoryOutcomes from "./FactoryOutcomes";
import FactoryHistory from "./FactoryHistory";
import FactoryWaitingStrip from "./FactoryWaitingStrip";
import { EmptyNote, FactoryDenied, FactoryError, Freshness, SectionCard, TimeCell, useNow } from "./FactoryPrimitives";
import {
	FACTORY_TREND_INTERVALS,
	FACTORY_TREND_SIZES,
	FACTORY_TREND_WORKFLOWS,
	type FactoryTrendInterval,
	type FactoryTrendSize,
	type FactoryTrendWorkflow,
	type FactoryWorker,
} from "./factoryTypes";

const { Text } = Typography;

const PUBLICATION_BACKLOG_STATES = ["pending", "uploading", "in_review", "error"] as const;

const oneOf = <T extends string>(values: readonly T[], value: string | null, fallback: T): T =>
	(values as readonly string[]).includes(value ?? "") ? (value as T) : fallback;

const WORKFLOW_OPTIONS: { value: FactoryTrendWorkflow; label: string }[] = [
	{ value: "all", label: "All workflows" },
	{ value: "geotiff", label: "GeoTIFF uploads" },
	{ value: "odm", label: "Raw image ZIPs" },
];
const SIZE_OPTIONS: { value: FactoryTrendSize; label: string }[] = [
	{ value: "all", label: "All sizes" },
	{ value: "small", label: "Under 1 GiB" },
	{ value: "large", label: "1 GiB and above" },
	{ value: "unknown", label: "Size not measured" },
];

/**
 * Operator triage: what needs care, what is waiting and for how long, what is
 * running, then measured processing outcomes and retained history.
 */
export default function FactoryOperations() {
	const [params, setParams] = useSearchParams();
	const interval = oneOf<FactoryTrendInterval>(FACTORY_TREND_INTERVALS, params.get("interval"), "week");
	const workflow = oneOf<FactoryTrendWorkflow>(FACTORY_TREND_WORKFLOWS, params.get("workflow"), "all");
	const size = oneOf<FactoryTrendSize>(FACTORY_TREND_SIZES, params.get("size"), "all");
	const selectedKey = params.get("bucket");
	const [historyOpen, setHistoryOpen] = useState(params.get("history") === "open");
	const operations = useFactoryOperations();
	const overview = useFactoryOverview(7);
	const trends = useFactoryTrends(interval, workflow, size);
	const journey = useFactoryJourney(historyOpen);
	const now = useNow();

	const update = (next: { interval?: FactoryTrendInterval; workflow?: FactoryTrendWorkflow; size?: FactoryTrendSize; bucket?: string | null; history?: boolean }) => {
		const merged = { interval, workflow, size, bucket: selectedKey, history: historyOpen, ...next };
		const search = new URLSearchParams();
		if (params.has("history_year")) search.set("history_year", params.get("history_year")!);
		if (merged.interval !== "week") search.set("interval", merged.interval);
		if (merged.workflow !== "all") search.set("workflow", merged.workflow);
		if (merged.size !== "all") search.set("size", merged.size);
		if (merged.bucket) search.set("bucket", merged.bucket);
		if (merged.history) search.set("history", "open");
		setParams(search, { replace: true });
	};

	const data = overview.data;
	const counts = data?.counts;

	if (isFactoryPermissionError(operations.error)) {
		return <FactoryDenied />;
	}

	const workerColumns: ColumnsType<FactoryWorker> = [
		{ title: "Worker", dataIndex: "worker_id", key: "worker_id", render: (value: string | null) => <span className="font-mono text-xs">{value || "unknown"}</span> },
		{
			title: "Dataset",
			dataIndex: "dataset_id",
			key: "dataset_id",
			render: (value: number | null) =>
				value ? (
					<Link to={`/factory/datasets/${value}`} state={{ factoryReturnTo: "/factory/operations" }} className="font-mono">
						#{value}
					</Link>
				) : (
					"—"
				),
		},
		{ title: "Tasks", dataIndex: "task_types", key: "task_types", render: (value: string[] | null) => <span className="text-xs">{formatTaskTypes(value)}</span> },
		{ title: "Claimed", dataIndex: "claimed_at", key: "claimed_at", render: (value: string | null) => <TimeCell iso={value} now={now} /> },
		{
			title: "Last DB signal",
			dataIndex: "last_signal_at",
			key: "last_signal_at",
			render: (value: string | null) => {
				const minutes = minutesSince(value, now);
				return (
					<span className="flex flex-wrap items-center gap-2">
						<TimeCell iso={value} now={now} emptyReason="No status update, log line or claim time is recorded." />
						{isSilentClaim(value, now) && minutes !== null && (
							<Tooltip title="No status update, log line or claim change for over an hour. A long stage looks the same; this is not proof it is stuck.">
								<Tag color="gold" className="m-0">
									silent for {formatDuration(minutes)}
								</Tag>
							</Tooltip>
						)}
					</span>
				);
			},
		},
	];

	return (
		<div className="space-y-6" data-testid="factory-operations">
			<div className="flex flex-wrap items-center gap-3">
				<Freshness
					asOf={operations.data?.as_of}
					isFetching={operations.isFetching || overview.isFetching}
					onRefresh={() => {
						void operations.refetch();
						void overview.refetch();
					}}
					now={now}
				/>
				<Text type="secondary" className="text-xs">
					attention and waiting lists
				</Text>
			</div>
			{operations.isError && operations.data && (
				<Alert type="warning" showIcon message="Attention data may be stale" description="The latest refresh failed. Previously loaded rows remain visible." data-testid="factory-operations-stale" />
			)}

			<FactoryAttentionList operations={operations.data} isLoading={operations.isLoading} error={operations.error} onRetry={() => void operations.refetch()} now={now} />

			<FactoryWaitingStrip operations={operations.data} isLoading={operations.isLoading} error={operations.error} onRetry={() => void operations.refetch()} now={now} />

			<SectionCard
				title="Running now"
				count={data?.workers.length}
				testId="factory-workers"
				extra={<Freshness asOf={data?.as_of} isFetching={overview.isFetching} onRefresh={() => void overview.refetch()} now={now} />}
			>
				{overview.isError && data && (
					<Alert type="warning" showIcon className="mb-3" message="Running claims may be stale" description="The latest refresh failed. Previously loaded claims remain visible." data-testid="factory-workers-stale" />
				)}
				{overview.isError && !data ? (
					<FactoryError error={overview.error} onRetry={() => void overview.refetch()} title="Could not load running claims" />
				) : !data ? (
					<Skeleton active paragraph={{ rows: 2 }} />
				) : data.workers.length === 0 ? (
					<EmptyNote>No queue row is claimed right now.</EmptyNote>
				) : (
					<Table size="small" pagination={false} dataSource={data.workers} columns={workerColumns} rowKey={(row, index) => `${row.worker_id}-${row.dataset_id}-${index}`} scroll={{ x: 640 }} />
				)}
				<Text type="secondary" className="mt-3 block text-xs">
					A claim is a database row held by a worker. The last signal is the newest status update, log line or claim time; it does not prove live
					progress.
					{data && (
						<>
							{" "}
							Uncertain (status not idle, no queue row): <Link to={factoryDatasetsPath({ state: "uncertain", sort: "attention" })}>{counts?.uncertain ?? "unknown"}</Link>. Publications not yet
							published: {counts?.publication_pending ?? "unknown"} (
							{PUBLICATION_BACKLOG_STATES.map((state, index) => (
								<span key={state}>
									{index > 0 && ", "}
									<Link to={factoryDatasetsPath({ publication: state })}>{state.replace("_", " ")}</Link>
								</span>
							))}
							).
						</>
					)}
				</Text>
			</SectionCard>

			<FactoryHistory />

			<div className="rounded-2xl border border-gray-200/60 bg-white px-5 py-4 shadow-sm" data-testid="factory-trend-controls">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div>
						<h3 className="m-0 text-base font-semibold text-gray-900">Is it improving?</h3>
						<Text type="secondary" className="text-xs">
							Measured upload-to-result outcomes. Workflow and size filter the charts below only; the lists above always show the whole platform.
						</Text>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Segmented<FactoryTrendInterval>
							value={interval}
							onChange={(value) => update({ interval: value, bucket: null })}
							options={[
								{ label: "Weeks", value: "week" },
								{ label: "Days", value: "day" },
							]}
							aria-label="Trend interval"
						/>
						<Select<FactoryTrendWorkflow> value={workflow} onChange={(value) => update({ workflow: value, bucket: null })} options={WORKFLOW_OPTIONS} style={{ width: 170 }} aria-label="Workflow" />
						<Select<FactoryTrendSize> value={size} onChange={(value) => update({ size: value, bucket: null })} options={SIZE_OPTIONS} style={{ width: 170 }} aria-label="Upload size" />
					</div>
				</div>
				<div className="mt-3" data-testid="factory-trend-freshness">
					<Freshness asOf={trends.data?.as_of} isFetching={trends.isFetching} onRefresh={() => void trends.refetch()} now={now} />
				</div>
				{trends.isError && trends.data && (
					<Alert type="warning" showIcon className="mt-3" message="Trend data may be stale" description="The latest trend refresh failed. Previously loaded charts remain visible." data-testid="factory-trend-stale" />
				)}
			</div>

			<FactoryOutcomes trends={trends.data} isLoading={trends.isLoading} error={trends.error} onRetry={() => void trends.refetch()} selectedKey={selectedKey} onSelect={(key) => update({ bucket: key })} />

			<Collapse
				className="rounded-2xl border border-gray-200/60 bg-white shadow-sm"
				activeKey={historyOpen ? ["history"] : []}
				onChange={(keys) => {
					const open = Array.isArray(keys) ? keys.includes("history") : keys === "history";
					setHistoryOpen(open);
					update({ history: open });
				}}
				items={[
					{
						key: "history",
						label: <span className="font-semibold text-gray-900">History and outcomes after the result</span>,
						extra: <span className="text-xs text-gray-500">observed first views, contributor cohorts</span>,
						children: (
							<div className="space-y-6" data-testid="factory-history">
								<FactoryJourneyOutcomes journey={journey.data} isLoading={journey.isLoading || (!journey.data && !journey.error)} error={journey.error} onRetry={() => void journey.refetch()} />
							</div>
						),
					},
				]}
			/>

			<Collapse
				ghost
				items={[
					{
						key: "coverage",
						label: <span className="text-sm text-gray-600">What these numbers cannot tell you</span>,
						children: (
							<div data-testid="factory-coverage">
								{(() => {
									const trendLines = trends.data?.coverage ?? [];
									const retained = data?.coverage ?? [];
									const lines = Array.from(new Set([...(operations.data?.coverage ?? []), ...trendLines, ...(journey.data?.coverage ?? []), ...retained]));
									return lines.length === 0 ? (
										<EmptyNote>No coverage notes were reported.</EmptyNote>
									) : (
										<ul className="m-0 list-disc space-y-1 pl-5 text-sm text-gray-600">
											{lines.map((line) => (
												<li key={line}>{line}</li>
											))}
										</ul>
									);
								})()}
							</div>
						),
					},
				]}
			/>
		</div>
	);
}
