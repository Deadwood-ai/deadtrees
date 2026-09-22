import { useState } from "react";
import { Alert, Button, Descriptions, Skeleton, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { CheckCircleFilled, FileTextOutlined, MinusCircleOutlined } from "@ant-design/icons";
import { Link, useLocation, useParams } from "react-router-dom";
import { useFactoryDataset } from "../../hooks/useFactory";
import { useCanAudit } from "../../hooks/useUserPrivileges";
import { stageLabel } from "../DatasetStatus/status";
import { contributorLabel, formatTaskTypes, formatUtc, intentLabel, notificationLabel, publicationLabel } from "./factoryFormat";
import FactoryRecordTable, { formatRecordValue, humanizeKey } from "./FactoryRecordTable";
import { useFactorySelection } from "./FactorySelectionContext";
import FactorySnapshotModal from "./FactorySnapshotModal";
import { EmptyNote, FactoryError, FactoryStateTag, Freshness, SectionCard, TimeCell, Unknown, useNow } from "./FactoryPrimitives";
import type { FactoryDatasetDetail as FactoryDatasetDetailData, FactoryLog, FactoryNotification, FactoryRecord } from "./factoryTypes";

const { Title, Text } = Typography;

const FLAG_LABELS: Record<string, string> = {
	is_upload_done: "Upload",
	is_odm_done: "Orthomosaic from raw images",
	is_ortho_done: "Orthophoto",
	is_metadata_done: "Metadata",
	is_cog_done: "Map image",
	is_thumbnail_done: "Preview",
	is_deadwood_done: "Deadwood prediction",
	is_forest_cover_done: "Forest cover prediction",
	is_combined_model_done: "Combined model",
	is_aoi_done: "Area of interest",
	is_aoi_required: "Area of interest required",
	is_embeddings_done: "Search indexing",
	is_audited: "Audited flag",
	is_in_audit: "Audit lock held",
};

const FLAG_ORDER = Object.keys(FLAG_LABELS);
const STATUS_SCALARS = [
	"current_status",
	"error_stage",
	"error_message",
	"updated_at",
	"created_at",
	"uploaded_at",
	"first_ready_at",
	"input_bytes",
	"workflow",
];
const STATUS_LABELS: Record<string, string> = {
	current_status: "Stage",
	uploaded_at: "Upload completed (measured)",
	first_ready_at: "First complete result (measured)",
	input_bytes: "Uploaded input size (measured on server)",
	workflow: "Workflow (measured)",
};

function StatusFlags({ status }: { status: FactoryRecord }) {
	const flagKeys = [
		...FLAG_ORDER.filter((key) => key in status),
		...Object.keys(status).filter((key) => key.startsWith("is_") && !(key in FLAG_LABELS)),
	];
	if (Object.keys(status).length === 0) {
		return <EmptyNote>No processing status row exists for this dataset.</EmptyNote>;
	}
	return (
		<div className="space-y-4">
			<ul className="m-0 grid list-none gap-x-6 gap-y-1 p-0 sm:grid-cols-2">
				{flagKeys.map((key) => {
					const value = status[key];
					const done = value === true;
					return (
						<li key={key} className="flex items-center gap-2 text-sm">
							{done ? <CheckCircleFilled className="text-green-600" /> : <MinusCircleOutlined className="text-gray-300" />}
							<span className={done ? "text-gray-800" : "text-gray-500"}>{FLAG_LABELS[key] ?? humanizeKey(key)}</span>
							{value === null && <span className="text-xs text-gray-400">(no value)</span>}
						</li>
					);
				})}
			</ul>
			<Descriptions size="small" column={1} bordered items={STATUS_SCALARS.filter((key) => key in status).map((key) => ({
				key,
				label: STATUS_LABELS[key] ?? humanizeKey(key),
				children:
					key === "current_status" && typeof status[key] === "string" ? (
						<span>
							{stageLabel(status[key] as string) ?? (status[key] as string)} <span className="text-xs text-gray-400">({status[key] as string})</span>
						</span>
					) : (
						<span className="whitespace-pre-wrap text-xs">{formatRecordValue(key, status[key])}</span>
					),
			}))} />
		</div>
	);
}

function DetailHeader({ detail, now }: { detail: FactoryDatasetDetailData; now: number }) {
	const row = detail.dataset;
	const { canAudit } = useCanAudit();
	const selection = useFactorySelection();
	const [snapshotOpen, setSnapshotOpen] = useState(false);
	const selected = selection.isSelected(row.dataset_id);

	return (
		<section className="rounded-2xl border border-gray-200/60 bg-white p-5 shadow-sm" data-testid="factory-detail-header">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<div className="flex flex-wrap items-center gap-3">
						<Title level={3} style={{ margin: 0 }}>
							Dataset #{row.dataset_id}
						</Title>
						<FactoryStateTag state={row.state} />
						{row.archived && <Tag className="m-0">archived</Tag>}
					</div>
					<Text className="mt-1 block text-gray-700">{row.file_name || <Unknown reason="No file name recorded." />}</Text>
					<Text type="secondary" className="block text-sm">
						{contributorLabel(row)} · created {row.created_at ? formatUtc(row.created_at) : "unknown"}
					</Text>
				</div>
				<Space wrap>
					<Button onClick={() => selection.toggle(row.dataset_id)} data-testid="factory-detail-select">
						{selected ? "Remove from selection" : "Add to selection"}
					</Button>
					<Button type="primary" icon={<FileTextOutlined />} onClick={() => setSnapshotOpen(true)}>
						Copy context
					</Button>
					<Tooltip title="Opens with your normal dataset permissions. Imagery is not part of Factory access.">
						<Link to={`/dataset/${row.dataset_id}`} target="_blank" rel="noopener noreferrer">
							<Button>Dataset page</Button>
						</Link>
					</Tooltip>
					{canAudit && (
						<Link to={`/dataset-audit/${row.dataset_id}`}>
							<Button>Audit</Button>
						</Link>
					)}
				</Space>
			</div>
			<Descriptions
				className="mt-4"
				size="small"
				column={{ xs: 1, sm: 2, lg: 4 }}
				items={[
					{ key: "stage", label: "Stage", children: row.stage ? `${stageLabel(row.stage) ?? row.stage} (${row.stage})` : <Unknown reason="No processing status row." /> },
					{ key: "intent", label: "Queue intent", children: row.state === "queued" || row.state === "claimed" ? intentLabel(row.intent) : <span className="text-gray-400">not queued</span> },
					{ key: "worker", label: "Worker", children: row.worker_id ? <span className="font-mono text-xs">{row.worker_id}</span> : <span className="text-gray-400">none</span> },
					{ key: "signal", label: "Last DB signal", children: <TimeCell iso={row.last_signal_at} now={now} emptyReason="No status update, log line or claim time is recorded." /> },
					{ key: "queued", label: "Queued", children: <TimeCell iso={row.queued_at} now={now} emptyLabel="no queue row" /> },
					{ key: "claimed", label: "Claimed", children: <TimeCell iso={row.claimed_at} now={now} emptyLabel="not claimed" /> },
					{ key: "tasks", label: "Queued tasks", children: formatTaskTypes(row.task_types) },
					{ key: "priority", label: "Priority", children: row.queue_priority ?? <span className="text-gray-400">—</span> },
					{ key: "delivery", label: "Delivery", children: <span>{notificationLabel(row)}{row.notification_problem && <Tag color="gold" className="m-0 ml-2">problem</Tag>}</span> },
					{ key: "publication", label: "Publication", children: publicationLabel(row.publication_state) },
					{ key: "reports", label: "Open reports", children: row.open_reports ?? 0 },
					{ key: "audit", label: "Audit record", children: row.has_audit ? "recorded" : "none" },
				]}
			/>
			{row.has_error && (
				<div className="mt-4 rounded-lg border border-red-100 bg-red-50 p-3 text-sm text-red-800" data-testid="factory-detail-error">
					<span className="font-semibold">Recorded error:</span> {row.error_message || "error flag set without a message"}
				</div>
			)}
			<FactorySnapshotModal open={snapshotOpen} ids={[row.dataset_id]} onClose={() => setSnapshotOpen(false)} />
		</section>
	);
}

export default function FactoryDatasetDetail() {
	const { id } = useParams();
	const location = useLocation();
	const previousList = location.state?.factoryReturnTo;
	const returnTo = typeof previousList === "string" && /^\/factory(?:\/datasets)?(?:\?|$)/.test(previousList) ? previousList : "/factory/datasets";
	const returnLabel = /^\/factory(?:\?|$)/.test(returnTo) ? "← Back to overview" : "← Back to datasets";
	const datasetId = id && /^\d+$/.test(id) ? Number(id) : null;
	const query = useFactoryDataset(datasetId);
	const now = useNow();

	if (datasetId === null) {
		return <FactoryError error={new Error("The dataset ID in the address is not a number.")} title="Invalid dataset link" />;
	}
	if (query.isError) {
		return <FactoryError error={query.error} onRetry={() => void query.refetch()} title={`Could not load dataset #${datasetId}`} />;
	}
	if (query.isLoading || query.data === undefined) {
		return <Skeleton active paragraph={{ rows: 8 }} />;
	}
	const detail = query.data;
	if (detail === null) {
		return <FactoryError error={new Error("The read model returned no dataset for this ID. It may not exist or may have been deleted.")} title={`Dataset #${datasetId} not found`} />;
	}

	const logColumns: ColumnsType<FactoryLog> = [
		{ title: "Time", dataIndex: "created_at", key: "created_at", width: 170, render: (value: string | null) => <span className="text-xs">{formatUtc(value)}</span> },
		{ title: "Level", dataIndex: "level", key: "level", width: 90, render: (value: string | null) => <Tag color={value === "ERROR" ? "red" : value === "WARNING" ? "gold" : undefined} className="m-0">{value || "INFO"}</Tag> },
		{ title: "Category", dataIndex: "category", key: "category", width: 140, render: (value: string | null) => <span className="text-xs">{value || "general"}</span> },
		{ title: "Message", dataIndex: "message", key: "message", render: (value: string | null) => <span className="whitespace-pre-wrap text-xs">{value || ""}</span> },
	];

	const notificationColumns: ColumnsType<FactoryNotification> = [
		{ title: "Recorded", dataIndex: "created_at", key: "created_at", width: 170, render: (value: string | null) => <span className="text-xs">{formatUtc(value)}</span> },
		{ title: "Event", dataIndex: "event_type", key: "event_type", width: 160, render: (value: string | null) => value?.replace(/_/g, " ") || "unknown" },
		{ title: "Status", dataIndex: "status", key: "status", width: 100, render: (value: string | null) => <Tag color={value === "sent" ? "green" : value === "failed" ? "red" : value === "skipped" ? "default" : "gold"} className="m-0">{value || "unknown"}</Tag> },
		{ title: "Recipients", dataIndex: "recipient_roles", key: "recipient_roles", width: 140, render: (value: string[] | null) => value?.join(", ") || "—" },
		{ title: "Attempts", dataIndex: "delivery_attempts", key: "delivery_attempts", width: 90, align: "right", render: (value: number | null) => value ?? "—" },
		{ title: "Next attempt", dataIndex: "next_attempt_at", key: "next_attempt_at", width: 170, render: (value: string | null) => <span className="text-xs">{value ? formatUtc(value) : "—"}</span> },
		{ title: "Sent", dataIndex: "sent_at", key: "sent_at", width: 170, render: (value: string | null) => <span className="text-xs">{value ? formatUtc(value) : "—"}</span> },
		{ title: "Delivery error", dataIndex: "delivery_error", key: "delivery_error", render: (value: string | null) => <span className="whitespace-pre-wrap text-xs text-red-700">{value || ""}</span> },
	];

	const truncatedHistory = Object.entries(detail.record_totals).filter(([, total]) => total > 200);
	const logsShown = detail.logs.length;
	const logTotal = detail.log_total;
	const correctionsShown = detail.corrections.length;
	const correctionTotal = detail.correction_total;

	return (
		<div className="space-y-6" data-testid="factory-detail">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<Link to={returnTo} data-testid="factory-detail-back">
					{returnLabel}
				</Link>
				<Freshness asOf={detail.as_of} isFetching={query.isFetching} onRefresh={() => void query.refetch()} now={now} />
			</div>

			<DetailHeader detail={detail} now={now} />

			<div className="grid gap-6 xl:grid-cols-2">
				<SectionCard title="Processing status" testId="factory-detail-status">
					<StatusFlags status={detail.status} />
				</SectionCard>
				<SectionCard title="Queue rows present now" count={detail.record_totals.queue ?? detail.queue.length} testId="factory-detail-queue">
					<FactoryRecordTable
						records={detail.queue}
						rowKey="id"
						columns={["id", "created_at", "is_processing", "claimed_by", "claimed_at", "priority", "task_types"]}
						labels={{ claimed_by: "Worker", is_processing: "Claimed" }}
						emptyText="No queue row now. Queue rows are removed when work finishes, so past attempts are not listed here."
					/>
				</SectionCard>
			</div>

			{truncatedHistory.length > 0 && (
				<Alert type="info" showIcon data-testid="factory-history-limit" message="Large histories show the newest 200 records per section"
					description={truncatedHistory.map(([section, total]) => `${section.replace(/_/g, " ")}: 200 of ${total.toLocaleString()}`).join(" · ")} />
			)}

			<SectionCard title="Logs" count={logTotal ?? logsShown} testId="factory-detail-logs" extra={logTotal !== null && logTotal > logsShown ? <Text type="secondary" className="text-xs">Showing the newest {logsShown} of {logTotal.toLocaleString()}</Text> : undefined}>
				{detail.logs.length === 0 ? (
					<EmptyNote>No log entries are recorded for this dataset.</EmptyNote>
				) : (
					<Table size="small" dataSource={detail.logs} columns={logColumns} rowKey="id" pagination={{ pageSize: 25, size: "small", showSizeChanger: false }} scroll={{ x: 760 }} />
				)}
			</SectionCard>

			<SectionCard title="Outputs" testId="factory-detail-outputs">
				<div className="grid gap-4 xl:grid-cols-2">
					{(
						[
							["Orthophotos", detail.outputs.orthos, "No orthophoto record."],
							["Map images", detail.outputs.cogs, "No map image record."],
							["Previews", detail.outputs.thumbnails, "No preview record."],
							["Raw image uploads", detail.outputs.raw_images, "No raw image record. GeoTIFF uploads have none."],
						] as const
					).map(([label, records, empty]) => (
						<div key={label}>
							<Text strong className="mb-2 block text-sm">
								{label} <span className="font-normal text-gray-400">{records.length}</span>
							</Text>
							<FactoryRecordTable records={records} emptyText={empty} />
						</div>
					))}
				</div>
				<Text type="secondary" className="mt-3 block text-xs">
					Records show that files or rows exist, with sizes and runtimes where stored. They do not show quality, and imagery stays behind the
					dataset page permissions.
				</Text>
			</SectionCard>

			<div className="grid gap-6 xl:grid-cols-2">
				<SectionCard title="Delivery" count={detail.record_totals.notifications ?? detail.notifications.length} testId="factory-detail-notifications">
					{detail.notifications.length === 0 ? (
						<EmptyNote>No delivery record. Notifications exist only for results recorded since the email feature launched, and only when it was enabled.</EmptyNote>
					) : (
						<Table size="small" dataSource={detail.notifications} columns={notificationColumns} rowKey="id" pagination={false} scroll={{ x: 900 }} />
					)}
					<Text type="secondary" className="mt-3 block text-xs">
						Sent means the provider accepted the message. It says nothing about delivery to an inbox or reading.
					</Text>
				</SectionCard>
				<SectionCard title="Publication" count={detail.record_totals.publications ?? detail.publications.length} testId="factory-detail-publications">
					<FactoryRecordTable records={detail.publications as unknown as FactoryRecord[]} rowKey="id" columns={["id", "status", "doi", "created_at", "published_at"]} emptyText="No publication record links to this dataset." />
				</SectionCard>
			</div>

			<div className="grid gap-6 xl:grid-cols-2">
				<SectionCard title="Reports" count={detail.record_totals.reports ?? detail.reports.length} testId="factory-detail-reports">
					<FactoryRecordTable
						records={detail.reports as unknown as FactoryRecord[]}
						rowKey="id"
						columns={["created_at", "flag_type", "status", "description", "auditor_comment", "updated_at"]}
						labels={{ flag_type: "Type" }}
						maxTextLength={220}
						emptyText="No issue reports for this dataset."
					/>
				</SectionCard>
				<SectionCard title="Audit records" count={detail.record_totals.audits ?? detail.audits.length} testId="factory-detail-audits">
					<FactoryRecordTable records={detail.audits} emptyText="No audit record. An audit record is a review entry, not a trust verdict." />
				</SectionCard>
			</div>

			<SectionCard title="Corrections" count={correctionTotal ?? correctionsShown} testId="factory-detail-corrections" extra={correctionTotal !== null && correctionTotal > correctionsShown ? <Text type="secondary" className="text-xs">Showing the newest {correctionsShown} of {correctionTotal.toLocaleString()}</Text> : undefined}>
				<FactoryRecordTable records={detail.corrections} rowKey="id" emptyText="No geometry corrections submitted for this dataset." />
			</SectionCard>
		</div>
	);
}
