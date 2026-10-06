import { Skeleton, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link } from "react-router-dom";
import { stageLabel } from "../DatasetStatus/status";
import { factoryDatasetsPath } from "./factoryFilters";
import { ATTENTION_DESCRIPTIONS, ATTENTION_SINCE_LABELS, attentionLabel, attentionTone, linearFailureSearchUrl, stateLabel, type FactoryTone } from "./factoryFormat";
import { EmptyNote, FactoryError, SectionCard, TimeCell } from "./FactoryPrimitives";
import type { FactoryAttentionGroup, FactoryOperations, FactoryRow } from "./factoryTypes";

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

const groupKey = (group: FactoryAttentionGroup) => `${group.reason}|${group.stage ?? ""}|${group.kind ?? ""}`;

function causeLabel(group: FactoryAttentionGroup): string {
	if (!group.stage) return ATTENTION_DESCRIPTIONS[group.reason] ?? attentionLabel(group.reason);
	const stage = stageLabel(group.stage) ?? group.stage;
	return `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
}

function GroupDatasets({ group, now }: { group: FactoryAttentionGroup; now: number }) {
	return (
		<ul className="m-0 list-none space-y-1 p-0" data-testid="attention-group-samples">
			{group.samples.map((sample) => (
				<li key={sample.dataset_id} className="flex flex-wrap items-baseline gap-x-3 text-xs">
					<Link to={`/factory/datasets/${sample.dataset_id}`} state={{ factoryReturnTo: "/factory/operations" }} className="font-mono font-medium">
						#{sample.dataset_id}
					</Link>
					<span className="max-w-[28rem] truncate text-gray-600" title={sample.file_name ?? undefined}>
						{sample.file_name || "no file name"}
					</span>
					<span className="text-gray-500">{stateLabel(sample.state)}</span>
					<TimeCell iso={sample.attention_since} now={now} emptyReason="No timestamp is tracked for this reason." />
				</li>
			))}
			{group.count > group.samples.length && (
				<li className="text-xs text-gray-500">
					and {group.count - group.samples.length} more.{" "}
					<Link to={factoryDatasetsPath({ ids: group.dataset_ids, sort: "attention" })}>Open the group in the explorer →</Link>
				</li>
			)}
		</ul>
	);
}

/**
 * What needs a person, grouped by reason and, for failures, by stage and error
 * class, so one fix or one Linear issue covers a whole row. Team backfill that
 * is only waiting is counted separately, not listed.
 */
export default function FactoryAttentionList({ operations, isLoading, error, onRetry, now }: FactoryAttentionListProps) {
	const allPath = factoryDatasetsPath({ attention: true, sort: "attention" });
	const columns: ColumnsType<FactoryAttentionGroup> = [
		{ title: "Reason", key: "reason", width: 140, render: (_, group) => <AttentionReasonTag reason={group.reason} /> },
		{
			title: "Cause",
			key: "cause",
			render: (_, group) => (
				<span className="flex flex-col leading-tight">
					<span className="font-medium text-gray-800" data-testid="attention-group-cause">
						{causeLabel(group)}
					</span>
					{group.kind && (
						<Tooltip title={group.kind}>
							<span className="max-w-[30rem] truncate text-xs text-red-700">{group.kind}</span>
						</Tooltip>
					)}
				</span>
			),
		},
		{
			title: "Datasets",
			key: "count",
			width: 110,
			align: "right",
			render: (_, group) => (
				<Link to={factoryDatasetsPath({ ids: group.dataset_ids, sort: "attention" })} className="font-mono font-medium" data-testid="attention-group-count">
					{group.count.toLocaleString()}
				</Link>
			),
		},
		{ title: "Contributors", key: "contributors", width: 110, align: "right", responsive: ["md"], render: (_, group) => group.contributors ?? "—" },
		{
			title: "Oldest",
			key: "oldest",
			width: 150,
			render: (_, group) => (
				<span className="flex flex-col leading-tight">
					<TimeCell iso={group.oldest_since} now={now} emptyReason="No timestamp is tracked for this reason; the duration is not known." />
					<span className="text-[11px] text-gray-400">{ATTENTION_SINCE_LABELS[group.reason]}</span>
				</span>
			),
		},
		{
			title: "Linear",
			key: "linear",
			width: 110,
			render: (_, group) =>
				group.stage ? (
					<a href={linearFailureSearchUrl(group.stage)} target="_blank" rel="noreferrer" className="text-xs" data-testid="attention-group-linear">
						Stage issue ↗
					</a>
				) : (
					<span className="text-gray-300">—</span>
				),
		},
	];

	const count = operations?.attention_total;
	const contributors = operations?.attention_contributors;
	const teamWaiting = operations?.team_waiting;

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
			) : (
				<>
					<Text type="secondary" className="mb-2 block text-xs" data-testid="factory-attention-summary">
						{typeof count === "number" ? `${count.toLocaleString()} dataset${count === 1 ? "" : "s"}` : "Unknown total"}
						{contributors !== null && contributors !== undefined && ` across ${contributors} contributor${contributors === 1 ? "" : "s"}`}, in{" "}
						{operations.attention_groups.length} group{operations.attention_groups.length === 1 ? "" : "s"}. Failures are grouped by stage and error; each stage has
						one Linear issue.
						{typeof teamWaiting === "number" && teamWaiting > 0 && (
							<span data-testid="factory-attention-team-waiting">
								{" "}
								{teamWaiting.toLocaleString()} team upload{teamWaiting === 1 ? " is" : "s are"} waiting in the queue and not counted here.
							</span>
						)}
					</Text>
					{operations.attention_groups.length === 0 ? (
						<EmptyNote>Nothing needs attention right now by these reasons. Waiting work and running claims are listed below.</EmptyNote>
					) : (
						<Table
							size="small"
							pagination={false}
							dataSource={operations.attention_groups}
							columns={columns}
							rowKey={groupKey}
							expandable={{ expandedRowRender: (group) => <GroupDatasets group={group} now={now} /> }}
							scroll={{ x: 900 }}
						/>
					)}
				</>
			)}
		</SectionCard>
	);
}
