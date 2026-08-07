import { useMemo, useState } from "react";
import { Alert, Button, Drawer, Result, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
	useDatasetLogs,
	type ProcessingOverviewRow,
	type ProcessingStatus,
} from "../../hooks/useProcessingOverview";
import { useIsMobile } from "../../hooks/useIsMobile";

const { Text } = Typography;

export const PROCESSING_ACTIVE_STATUSES = ["QUEUED", "PROCESSING", "FAILED"] as const satisfies readonly ProcessingStatus[];

type ProcessingAuditTabProps = {
	rows: ProcessingOverviewRow[];
	isLoading: boolean;
	isError: boolean;
	onRefresh: () => void;
};

const formatHours = (value: number | null | undefined): string => {
	if (typeof value !== "number" || Number.isNaN(value)) return "—";
	return `${value.toFixed(1)}h`;
};

export default function ProcessingAuditTab({ rows, isLoading, isError, onRefresh }: ProcessingAuditTabProps) {
	const isMobile = useIsMobile();
	const [statusFilters, setStatusFilters] = useState<ProcessingStatus[]>([...PROCESSING_ACTIVE_STATUSES]);
	const [stageFilter, setStageFilter] = useState<string | undefined>(undefined);
	const [userFilter, setUserFilter] = useState<string | undefined>(undefined);
	const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(null);
	const [logLimit, setLogLimit] = useState(100);

	const stageOptions = useMemo(() => {
		const stages = new Set(
			rows
				.map((row) => row.current_status)
				.filter((status): status is string => typeof status === "string" && status.length > 0)
		);
		return Array.from(stages)
			.sort()
			.map((value) => ({ label: value, value }));
	}, [rows]);

	const userOptions = useMemo(() => {
		const users = new Set(
			rows
				.map((row) => row.user_email)
				.filter((email): email is string => typeof email === "string" && email.length > 0)
		);
		return Array.from(users)
			.sort()
			.map((value) => ({ label: value, value }));
	}, [rows]);

	const filteredRows = useMemo(() => {
		return rows.filter((row) => {
			if (statusFilters.length > 0 && !statusFilters.includes((row.processing_status || "") as ProcessingStatus)) {
				return false;
			}
			if (stageFilter && row.current_status !== stageFilter) return false;
			if (userFilter && row.user_email !== userFilter) return false;
			return true;
		});
	}, [rows, statusFilters, stageFilter, userFilter]);

	const selectedRow = useMemo(
		() => rows.find((row) => row.dataset_id === selectedDatasetId) || null,
		[rows, selectedDatasetId]
	);
	const { data: selectedDatasetLogs = [], isLoading: isLogsLoading, refetch: refetchSelectedDatasetLogs } =
		useDatasetLogs(selectedDatasetId, logLimit);

	const columns: ColumnsType<ProcessingOverviewRow> = [
		{
			title: "ID",
			dataIndex: "dataset_id",
			key: "dataset_id",
			width: 90,
			defaultSortOrder: "descend",
			sorter: (a, b) => a.dataset_id - b.dataset_id,
		},
		{
			title: "File",
			dataIndex: "file_name",
			key: "file_name",
			width: 220,
			ellipsis: true,
			render: (value: string | null) => value || "—",
		},
		{
			title: "Processing",
			key: "processing_status",
			width: 170,
			render: (_, record) => {
				const status = record.processing_status || "UNKNOWN";
				const color =
					status === "PROCESSING"
						? "blue"
						: status === "QUEUED"
							? "orange"
							: status === "FAILED"
								? "red"
								: "green";
				return (
					<Tag color={color} className="whitespace-nowrap">
						{status}
					</Tag>
				);
			},
		},
		{
			title: "Stage",
			dataIndex: "current_status",
			key: "current_status",
			width: 130,
			render: (value: string | null) => <Tag>{value || "idle"}</Tag>,
		},
		{
			title: "Stuck",
			key: "hours_in_current_status",
			width: 100,
			render: (_, record) => <span className="font-mono text-xs">{formatHours(record.hours_in_current_status)}</span>,
			sorter: (a, b) => (a.hours_in_current_status || 0) - (b.hours_in_current_status || 0),
		},
		{
			title: "Owner",
			dataIndex: "user_email",
			key: "user_email",
			width: 220,
			render: (value: string | null) => value || "—",
		},
		{
			title: "Queue",
			key: "queue",
			width: 90,
			render: (_, record) => (record.queue_priority === null ? "—" : `P${record.queue_priority}`),
		},
		{
			title: "Error",
			key: "error",
			width: 200,
			render: (_, record) => {
				if (!record.has_error) return <span className="text-gray-400">—</span>;
				const messageText = record.error_message || "Error";
				const shortText = messageText.length > 80 ? `${messageText.slice(0, 80)}...` : messageText;
				return (
					<Tooltip title={messageText}>
						<span className="text-red-600">{shortText}</span>
					</Tooltip>
				);
			},
		},
		{
			title: "Logs Preview",
			key: "logs_preview",
			width: 280,
			render: (_, record) => {
				if (!record.last_20_logs) return <span className="text-gray-400">No logs</span>;
				const preview = record.last_20_logs.split("\n").slice(0, 2).join("\n");
				return (
					<Tooltip title={record.last_20_logs}>
						<pre className="m-0 max-h-16 overflow-hidden whitespace-pre-wrap text-xs leading-tight">{preview}</pre>
					</Tooltip>
				);
			},
		},
		{
			title: "Actions",
			key: "actions",
			width: 120,
			render: (_, record) => (
				<Button size="small" onClick={() => setSelectedDatasetId(record.dataset_id)}>
					View Logs
				</Button>
			),
		},
	];

	if (isError && rows.length === 0) {
		return (
			<Result
				status="error"
				title="Could not load processing data"
				subTitle="The processing overview could not be loaded. Please try again."
				extra={<Button onClick={onRefresh}>Try again</Button>}
			/>
		);
	}

	return (
		<>
			{isError && (
				<Alert
					type="warning"
					showIcon
					message="Processing data may be stale"
					description="The latest refresh failed. Previously loaded processing data remains visible."
					action={<Button onClick={onRefresh}>Try again</Button>}
					className="mb-4"
				/>
			)}
			<div className="mb-4 flex flex-wrap items-end gap-3 rounded-md border border-gray-100 bg-gray-50 p-3">
				<div>
					<Text type="secondary" className="block mb-1 text-xs">
						Processing Status
					</Text>
					<Select
						mode="multiple"
						allowClear
						placeholder="Select statuses"
						style={{ width: isMobile ? 280 : 360 }}
						value={statusFilters}
						onChange={(value) => setStatusFilters(value as ProcessingStatus[])}
						options={[
							{ label: "Processing", value: "PROCESSING" },
							{ label: "Queued", value: "QUEUED" },
							{ label: "Failed", value: "FAILED" },
							{ label: "Completed", value: "COMPLETED" },
						]}
					/>
				</div>
				<div>
					<Text type="secondary" className="block mb-1 text-xs">
						Stage
					</Text>
					<Select
						allowClear
						placeholder="All stages"
						style={{ width: isMobile ? 160 : 200 }}
						value={stageFilter}
						onChange={setStageFilter}
						options={stageOptions}
						showSearch
					/>
				</div>
				<div>
					<Text type="secondary" className="block mb-1 text-xs">
						Owner
					</Text>
					<Select
						allowClear
						placeholder="All owners"
						style={{ width: isMobile ? 220 : 260 }}
						value={userFilter}
						onChange={setUserFilter}
						options={userOptions}
						showSearch
					/>
				</div>
				<Space>
					<Button onClick={onRefresh}>Refresh</Button>
					<Button
						onClick={() => {
							setStatusFilters([...PROCESSING_ACTIVE_STATUSES]);
							setStageFilter(undefined);
							setUserFilter(undefined);
						}}
					>
						Reset
					</Button>
				</Space>
			</div>

			<Table
				dataSource={filteredRows}
				columns={columns}
				rowKey="dataset_id"
				loading={isLoading}
				onRow={(record) => ({
					onClick: () => setSelectedDatasetId(record.dataset_id),
				})}
				pagination={{
					pageSize: 25,
					showSizeChanger: true,
					showQuickJumper: true,
					showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} datasets`,
				}}
				scroll={{ x: isMobile ? 980 : 1400 }}
			/>

			<Drawer
				title={`Dataset ${selectedDatasetId || ""} Logs`}
				open={selectedDatasetId !== null}
				onClose={() => setSelectedDatasetId(null)}
				width={isMobile ? "100%" : 820}
			>
				<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
					<Space>
						<Text type="secondary">Log entries</Text>
						<Select
							value={logLimit}
							onChange={setLogLimit}
							style={{ width: 110 }}
							options={[
								{ label: "50", value: 50 },
								{ label: "100", value: 100 },
								{ label: "200", value: 200 },
							]}
						/>
					</Space>
					<Space>
						{selectedRow?.current_status && <Tag>{selectedRow.current_status}</Tag>}
						<Button onClick={() => refetchSelectedDatasetLogs()}>Refresh Logs</Button>
					</Space>
				</div>
				<Table
					rowKey="id"
					size="small"
					loading={isLogsLoading}
					dataSource={selectedDatasetLogs}
					pagination={false}
					columns={[
						{
							title: "Time",
							dataIndex: "created_at",
							key: "created_at",
							width: 170,
							render: (value: string) => new Date(value).toLocaleString(),
						},
						{
							title: "Level",
							dataIndex: "level",
							key: "level",
							width: 90,
							render: (value: string | null) => <Tag>{value || "INFO"}</Tag>,
						},
						{
							title: "Category",
							dataIndex: "category",
							key: "category",
							width: 140,
							render: (value: string | null) => value || "general",
						},
						{
							title: "Message",
							dataIndex: "message",
							key: "message",
							render: (value: string | null) => (
								<span className="whitespace-pre-wrap text-xs">{value || ""}</span>
							),
						},
					]}
				/>
			</Drawer>
		</>
	);
}
