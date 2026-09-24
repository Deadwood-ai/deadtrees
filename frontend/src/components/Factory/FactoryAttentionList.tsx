import { Skeleton, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link } from "react-router-dom";
import { stageLabel } from "../DatasetStatus/status";
import { factoryDatasetsPath } from "./factoryFilters";
import { ATTENTION_DESCRIPTIONS, ATTENTION_SINCE_LABELS, attentionLabel, attentionTone, truncate, type FactoryTone } from "./factoryFormat";
import { EmptyNote, FactoryError, FactoryStateTag, SectionCard, TimeCell, Unknown } from "./FactoryPrimitives";
import type { FactoryOperations, FactoryRow } from "./factoryTypes";

const { Text } = Typography;

const TONE_COLORS: Record<FactoryTone, string | undefined> = {
	error: "red",
	warning: "gold",
	processing: "processing",
	success: "green",
	muted: "default",
	default: undefined,
};

export function AttentionReasonTag({ reason }: { reason: string | null | undefined }) {
	if (!reason) return <span className="text-gray-400">—</span>;
	return (
		<Tooltip title={ATTENTION_DESCRIPTIONS[reason]}>
			<Tag color={TONE_COLORS[attentionTone(reason)]} className="m-0 whitespace-nowrap" data-testid="attention-reason">
				{attentionLabel(reason)}
			</Tag>
		</Tooltip>
	);
}

export function AttentionSince({ row, now }: { row: Pick<FactoryRow, "attention_reason" | "attention_since">; now: number }) {
	const label = row.attention_reason ? ATTENTION_SINCE_LABELS[row.attention_reason] : undefined;
	return (
		<span className="flex flex-col leading-tight">
			<TimeCell iso={row.attention_since} now={now} emptyReason="No timestamp is tracked for this reason; the duration is not known." />
			{label && <span className="text-[11px] text-gray-400">{label}</span>}
		</span>
	);
}

type FactoryAttentionListProps = {
	operations: FactoryOperations | undefined;
	isLoading: boolean;
	error: unknown;
	onRetry: () => void;
	now: number;
};

/** The ranked answer to "what needs care": the server orders by reason severity, then oldest known time. */
export default function FactoryAttentionList({ operations, isLoading, error, onRetry, now }: FactoryAttentionListProps) {
	const allPath = factoryDatasetsPath({ attention: true, sort: "attention" });
	const columns: ColumnsType<FactoryRow> = [
		{
			title: "#",
			dataIndex: "attention_rank",
			key: "rank",
			width: 44,
			render: (_value, _row, index) => <span className="text-xs text-gray-400">{index + 1}</span>,
		},
		{
			title: "Dataset",
			dataIndex: "dataset_id",
			key: "dataset_id",
			width: 170,
			render: (value: number, row) => (
				<span className="flex flex-col leading-tight">
					<Link to={`/factory/datasets/${value}`} state={{ factoryReturnTo: "/factory/operations" }} className="font-mono font-medium">
						#{value}
					</Link>
					<span className="truncate text-xs text-gray-500" title={row.file_name ?? undefined}>
						{row.file_name || "no file name"}
					</span>
				</span>
			),
		},
		{ title: "Reason", key: "reason", width: 140, render: (_, row) => <AttentionReasonTag reason={row.attention_reason} /> },
		{ title: "Since", key: "since", width: 150, render: (_, row) => <AttentionSince row={row} now={now} /> },
		{
			title: "Contributor",
			key: "contributor",
			width: 200,
			ellipsis: true,
			responsive: ["md"],
			render: (_, row) => row.user_email || (row.user_id ? <span className="font-mono text-xs">{row.user_id}</span> : <Unknown />),
		},
		{
			title: "State · stage",
			key: "state",
			width: 220,
			render: (_, row) => (
				<span className="flex flex-wrap items-center gap-1">
					<FactoryStateTag state={row.state} />
					{row.stage && (
						<Tooltip title={row.stage}>
							<span className="text-xs text-gray-600">{stageLabel(row.stage) ?? row.stage}</span>
						</Tooltip>
					)}
				</span>
			),
		},
		{
			title: "Worker · last DB signal",
			key: "worker",
			width: 200,
			responsive: ["lg"],
			render: (_, row) => (
				<span className="flex flex-col leading-tight">
					<span className="font-mono text-xs">{row.worker_id || <span className="font-sans text-gray-400">no claim</span>}</span>
					<TimeCell iso={row.last_signal_at} now={now} emptyReason="No status update, log line or claim time is recorded." />
				</span>
			),
		},
		{
			title: "Error",
			key: "error",
			width: 260,
			ellipsis: true,
			responsive: ["xl"],
			render: (_, row) =>
				row.has_error ? (
					<Tooltip title={row.error_message || "error flag set without a message"}>
						<span className="block truncate text-xs text-red-700">{truncate(row.error_message || "error flag set without a message", 70)}</span>
					</Tooltip>
				) : (
					<span className="text-gray-300">—</span>
				),
		},
	];

	const count = operations?.attention_total;
	const contributors = operations?.attention_contributors;

	return (
		<SectionCard
			title="Needs attention"
			testId="factory-attention"
			extra={
				operations && (
					<Link to={allPath} data-testid="factory-attention-all">
						Open all {typeof count === "number" ? count : ""} in the explorer →
					</Link>
				)
			}
		>
			{error && !operations ? (
				<FactoryError error={error} onRetry={onRetry} title="Could not load the attention list" />
			) : isLoading || !operations ? (
				<Skeleton active paragraph={{ rows: 4 }} />
			) : operations.attention.length === 0 ? (
				<EmptyNote>Nothing needs attention right now by these reasons. Waiting work and running claims are listed below.</EmptyNote>
			) : (
				<>
					<Text type="secondary" className="mb-2 block text-xs" data-testid="factory-attention-summary">
						{typeof count === "number" ? `${count.toLocaleString()} dataset${count === 1 ? "" : "s"}` : "Unknown total"}
						{contributors !== null && contributors !== undefined && ` across ${contributors} contributor${contributors === 1 ? "" : "s"}`}. Ranked by reason,
						then by the oldest known time. Showing the top {operations.attention.length}.
					</Text>
					<Table size="small" pagination={false} dataSource={operations.attention} columns={columns} rowKey="dataset_id" scroll={{ x: 1180 }} />
				</>
			)}
		</SectionCard>
	);
}
