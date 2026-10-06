import { Alert, Skeleton, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link } from "react-router-dom";
import { stageLabel } from "../DatasetStatus/status";
import type { ReactNode } from "react";
import { formatDuration, formatTaskTypes, minutesSince, type FactoryTone } from "./factoryFormat";
import { EmptyNote, FactoryError, Freshness, SectionCard, TimeCell, TONE_COLORS } from "./FactoryPrimitives";
import type { FactoryProcessor, FactoryProcessorState, FactoryProcessors as FactoryProcessorsData } from "./factoryTypes";

const STATE_TAGS: Record<FactoryProcessorState, { tone: FactoryTone; label: string; help: string }> = {
	working: { tone: "processing", label: "Working", help: "Holds a claim with a database signal in the last hour." },
	silent: { tone: "warning", label: "Silent", help: "Holds a claim without a database signal for over an hour. A long stage looks the same." },
	idle: { tone: "muted", label: "Idle", help: "No claim, and a heartbeat in the last 10 minutes." },
	unknown: { tone: "warning", label: "Unknown", help: "No claim and no heartbeat in the last 10 minutes: offline, stuck outside a task, or running a release from before heartbeats." },
};

function ProcessorState({ state }: { state: FactoryProcessorState }) {
	const tag = STATE_TAGS[state];
	return (
		<Tooltip title={tag.help}>
			<Tag color={TONE_COLORS[tag.tone]} className="m-0" data-testid="processor-state">
				{tag.label}
			</Tag>
		</Tooltip>
	);
}

function CurrentTask({ processor, now }: { processor: FactoryProcessor; now: number }) {
	if (processor.claims.length === 0) return <span className="text-gray-400">no claim</span>;
	return (
		<span className="flex flex-col gap-1">
			{processor.claims.map((claim) => {
				const running = minutesSince(claim.claimed_at, now);
				return (
					<span key={claim.dataset_id} className="flex flex-col leading-tight">
						<span>
							<Link to={`/factory/datasets/${claim.dataset_id}`} state={{ factoryReturnTo: "/factory/operations" }} className="font-mono font-medium">
								#{claim.dataset_id}
							</Link>{" "}
							<span className="text-xs text-gray-600">{stageLabel(claim.stage) ?? claim.stage ?? formatTaskTypes(claim.task_types)}</span>
						</span>
						<span className="max-w-[18rem] truncate text-xs text-gray-500" title={claim.file_name ?? undefined}>
							{claim.file_name || "no file name"}
							{running !== null && ` · running ${formatDuration(running)}`}
						</span>
					</span>
				);
			})}
		</span>
	);
}

type FactoryProcessorsProps = {
	data: FactoryProcessorsData | undefined;
	isFetching: boolean;
	isError: boolean;
	error: unknown;
	onRetry: () => void;
	now: number;
	/** Notes shown under the table. */
	footer?: ReactNode;
};

/** One row per processor host: what it holds now and what it did in the last 24 hours. */
export default function FactoryProcessors({ data, isFetching, isError, error, onRetry, now, footer }: FactoryProcessorsProps) {
	const columns: ColumnsType<FactoryProcessor> = [
		{
			title: "Processor",
			key: "name",
			width: 170,
			render: (_, row) => (
				<span className="flex flex-col leading-tight">
					<span className="font-medium text-gray-900">{row.name}</span>
					{row.name !== row.worker_id && <span className="font-mono text-[11px] text-gray-400">{row.worker_id}</span>}
					{row.backend_version && <span className="text-[11px] text-gray-400">release {row.backend_version}</span>}
				</span>
			),
		},
		{ title: "State", key: "state", width: 100, render: (_, row) => <ProcessorState state={row.state} /> },
		{ title: "Current task", key: "task", render: (_, row) => <CurrentTask processor={row} now={now} /> },
		{
			title: "Last signal",
			key: "signal",
			width: 140,
			render: (_, row) => <TimeCell iso={row.last_signal_at} now={now} emptyReason="No claim, heartbeat or host-tagged log line is recorded." />,
		},
		{
			title: "Last 24 h",
			key: "day",
			width: 210,
			render: (_, row) => (
				<span className="whitespace-nowrap text-xs text-gray-700" data-testid="processor-day">
					{row.started_24h ?? "—"} started · {row.completed_24h ?? "—"} finished ·{" "}
					<span className={row.failed_24h ? "text-red-700" : undefined}>{row.failed_24h ?? "—"} failed</span>
				</span>
			),
		},
		{
			title: "Last failure (24 h)",
			key: "failure",
			width: 170,
			responsive: ["md"],
			render: (_, row) =>
				row.last_failure ? (
					<span className="flex flex-col leading-tight">
						<Link to={`/factory/datasets/${row.last_failure.dataset_id}`} state={{ factoryReturnTo: "/factory/operations" }} className="font-mono text-xs">
							#{row.last_failure.dataset_id}
						</Link>
						<span className="text-[11px] text-gray-500">
							{stageLabel(row.last_failure.stage) ?? row.last_failure.stage ?? "unknown stage"}, <TimeCell iso={row.last_failure.at} now={now} />
						</span>
					</span>
				) : (
					<span className="text-gray-300">—</span>
				),
		},
	];

	return (
		<SectionCard
			title="Processors"
			count={data?.processors.length}
			testId="factory-processors"
			extra={<Freshness asOf={data?.as_of} isFetching={isFetching} onRefresh={onRetry} now={now} />}
		>
			{isError && data && (
				<Alert type="warning" showIcon className="mb-3" message="Processor data may be stale" description="The latest refresh failed. Previously loaded rows remain visible." data-testid="factory-processors-stale" />
			)}
			{isError && !data ? (
				<FactoryError error={error} onRetry={onRetry} title="Could not load processors" />
			) : !data ? (
				<Skeleton active paragraph={{ rows: 3 }} />
			) : data.processors.length === 0 ? (
				<EmptyNote>No processor host is known.</EmptyNote>
			) : (
				<Table size="small" pagination={false} dataSource={data.processors} columns={columns} rowKey="worker_id" scroll={{ x: 860 }} />
			)}
			{footer}
		</SectionCard>
	);
}
