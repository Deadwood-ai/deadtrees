import { useCallback, useMemo } from "react";
import { Alert, Button, Segmented, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link, useSearchParams } from "react-router-dom";
import { useFactoryDatasets } from "../../hooks/useFactory";
import { stageLabel } from "../DatasetStatus/status";
import { FACTORY_PAGE_SIZE, parseFactoryFilters, parsePage, serializeFactoryFilters } from "./factoryFilters";
import { intentLabel, isSilentClaim, notificationLabel, publicationLabel, truncate } from "./factoryFormat";
import { AttentionReasonTag, AttentionSince } from "./FactoryAttentionList";
import FactoryDatasetFilters from "./FactoryDatasetFilters";
import { useFactorySelection } from "./FactorySelectionContext";
import { FactoryError, FactoryStateTag, Freshness, TimeCell, Unknown, useNow } from "./FactoryPrimitives";
import type { FactoryFilters, FactoryRow } from "./factoryTypes";
import { useFactoryListPosition } from "./useFactoryListPosition";

const { Text } = Typography;

export default function FactoryDatasets() {
	const [params, setParams] = useSearchParams();
	const filters = useMemo(() => parseFactoryFilters(params), [params]);
	const page = parsePage(params);
	const query = useFactoryDatasets(filters, page, FACTORY_PAGE_SIZE);
	const { container, rememberPosition, returnTo } = useFactoryListPosition(Boolean(query.data) && !query.isPlaceholderData);
	const selection = useFactorySelection();
	const now = useNow();

	const applyFilters = useCallback(
		(next: FactoryFilters) => {
			setParams(serializeFactoryFilters(next));
		},
		[setParams]
	);

	const setPage = (nextPage: number) => {
		const next = serializeFactoryFilters(filters);
		if (nextPage > 1) next.set("page", String(nextPage));
		setParams(next);
	};

	const rows = query.data?.items ?? [];
	const attentionOrder = filters.sort === "attention";
	const showAttentionColumns = attentionOrder || filters.attention === true;
	const setSort = (sort: "newest" | "attention") => {
		const next = { ...filters };
		if (sort === "attention") next.sort = "attention";
		else delete next.sort;
		setParams(serializeFactoryFilters(next));
	};
	const total = query.data?.total ?? null;

	const columns: ColumnsType<FactoryRow> = [
		{
			title: "ID",
			dataIndex: "dataset_id",
			key: "dataset_id",
			width: 96,
			fixed: "left",
			render: (value: number) => (
				<Link to={`/factory/datasets/${value}`} state={{ factoryReturnTo: returnTo }} onClick={rememberPosition} className="font-mono font-medium">
					#{value}
				</Link>
			),
		},
		{
			title: "File",
			dataIndex: "file_name",
			key: "file_name",
			width: 220,
			ellipsis: true,
			render: (value: string | null) => value || <Unknown reason="No file name recorded." />,
		},
		...(showAttentionColumns
			? ([
					{ title: "Reason", key: "attention_reason", width: 140, render: (_: unknown, row: FactoryRow) => <AttentionReasonTag reason={row.attention_reason} /> },
					{ title: "Since", key: "attention_since", width: 150, render: (_: unknown, row: FactoryRow) => <AttentionSince row={row} now={now} /> },
				] as ColumnsType<FactoryRow>)
			: []),
		{
			title: "Contributor",
			key: "contributor",
			width: 240,
			ellipsis: true,
			render: (_, row) => (
				<span className="block truncate">
					{row.user_email || (row.user_id ? <span className="font-mono text-xs">{row.user_id}</span> : <Unknown />)}
					{row.organisation && <span className="block truncate text-xs text-gray-500">{row.organisation}</span>}
				</span>
			),
		},
		{
			title: "State",
			key: "state",
			width: 150,
			render: (_, row) => (
				<span className="flex flex-col gap-1">
					<FactoryStateTag state={row.state} />
					{(row.state === "queued" || row.state === "claimed") && (
						<Tooltip title="Queue purpose comes from durable provenance only. Task types alone do not prove intent.">
							<span className="text-[11px] text-gray-500">intent: {intentLabel(row.intent)}</span>
						</Tooltip>
					)}
				</span>
			),
		},
		{
			title: "Stage",
			dataIndex: "stage",
			key: "stage",
			width: 160,
			render: (value: string | null) =>
				value ? (
					<Tooltip title={value}>
						<span className="text-xs">{stageLabel(value) ?? value}</span>
					</Tooltip>
				) : (
					<Unknown reason="No processing status row exists for this dataset." />
				),
		},
		{
			title: "Worker",
			dataIndex: "worker_id",
			key: "worker_id",
			width: 150,
			ellipsis: true,
			render: (value: string | null, row) =>
				value ? <span className="font-mono text-xs">{value}</span> : <span className="text-gray-400">{row.state === "claimed" ? "unknown" : "none"}</span>,
		},
		{
			title: "Last DB signal",
			dataIndex: "last_signal_at",
			key: "last_signal_at",
			width: 170,
			render: (value: string | null, row) => (
				<span className="flex flex-wrap items-center gap-1">
					<TimeCell iso={value} now={now} emptyReason="No status update, log line or claim time is recorded." />
					{row.state === "claimed" && isSilentClaim(value, now) && (
						<Tag color="gold" className="m-0">
							silent
						</Tag>
					)}
				</span>
			),
		},
		{
			title: "Created",
			dataIndex: "created_at",
			key: "created_at",
			width: 130,
			responsive: ["lg"],
			render: (value: string | null) => <TimeCell iso={value} now={now} />,
		},
		{
			title: "Delivery",
			key: "delivery",
			width: 140,
			render: (_, row) => (
				<span className="flex flex-wrap items-center gap-1 text-xs">
					<span className={row.notification_state && row.notification_state !== "none" ? "" : "text-gray-400"}>{notificationLabel(row)}</span>
					{row.notification_problem && (
						<Tag color="gold" className="m-0">
							problem
						</Tag>
					)}
				</span>
			),
		},
		{
			title: "Publication",
			dataIndex: "publication_state",
			key: "publication_state",
			width: 120,
			responsive: ["lg"],
			render: (value: string | null) => <span className={`text-xs ${!value || value === "none" ? "text-gray-400" : ""}`}>{publicationLabel(value)}</span>,
		},
		{
			title: "Reports",
			dataIndex: "open_reports",
			key: "open_reports",
			width: 90,
			align: "right",
			render: (value: number | null) => (value ? <Tag color="volcano" className="m-0">{value} open</Tag> : <span className="text-gray-400">0</span>),
		},
		{
			title: "Audit",
			dataIndex: "has_audit",
			key: "has_audit",
			width: 80,
			responsive: ["lg"],
			render: (value: boolean | null) => (value ? "recorded" : <span className="text-gray-400">none</span>),
		},
		{
			title: "Error",
			key: "error",
			width: 260,
			render: (_, row) => {
				if (!row.has_error) return <span className="text-gray-300">—</span>;
				const text = row.error_message || "error recorded without message";
				return (
					<Tooltip title={text}>
						<span className="text-xs text-red-700">{truncate(text, 90)}</span>
					</Tooltip>
				);
			},
		},
	];

	if (query.isError && !query.data) {
		return (
			<div className="space-y-4">
				<FactoryDatasetFilters filters={filters} onChange={applyFilters} onReset={() => setParams(new URLSearchParams())} />
				<FactoryError error={query.error} onRetry={() => void query.refetch()} title="Could not load datasets" />
			</div>
		);
	}

	return (
		<div ref={container} className="space-y-4" data-testid="factory-datasets">
			<FactoryDatasetFilters filters={filters} onChange={applyFilters} onReset={() => setParams(new URLSearchParams())} />

			{query.isError && query.data && (
				<Alert type="warning" showIcon message="List may be stale" description="The latest refresh failed. Previously loaded rows remain visible." action={<Button onClick={() => void query.refetch()}>Try again</Button>} />
			)}

			<div className="rounded-2xl border border-gray-200/60 bg-white p-4 shadow-sm">
				<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
					<Text data-testid="factory-datasets-total">
						{query.data ? (
							total === null ? (
								<>
									<Unknown reason="The read model did not report a total." /> datasets match ·{" "}
									<span data-testid="factory-order-label">{attentionOrder ? "needs attention first (server ranked)" : "newest first"}</span>
								</>
							) : (
								<>
									<span className="font-semibold">{total.toLocaleString()}</span> dataset{total === 1 ? "" : "s"} match ·{" "}
									<span data-testid="factory-order-label">{attentionOrder ? "needs attention first (server ranked)" : "newest first"}</span>
								</>
							)
						) : (
							"Loading datasets…"
						)}
					</Text>
					<div className="flex flex-wrap items-center gap-3">
						<Segmented<"newest" | "attention">
							size="small"
							value={attentionOrder ? "attention" : "newest"}
							onChange={setSort}
							options={[
								{ label: "Newest first", value: "newest" },
								{ label: "Needs attention first", value: "attention" },
							]}
							aria-label="List order"
							data-testid="factory-sort"
						/>
						<Freshness asOf={query.data?.as_of} isFetching={query.isFetching} onRefresh={() => void query.refetch()} now={now} />
					</div>
				</div>
				<Table<FactoryRow>
					dataSource={rows}
					columns={columns}
					rowKey="dataset_id"
					loading={query.isLoading || query.isPlaceholderData}
					size="middle"
					rowClassName={query.isPlaceholderData ? "opacity-50" : undefined}
					rowSelection={{
						selectedRowKeys: selection.selectedIds,
						preserveSelectedRowKeys: true,
						getCheckboxProps: () => ({ disabled: query.isPlaceholderData }),
						onSelect: (record) => selection.toggle(record.dataset_id),
						onSelectAll: (selected, _rows, changeRows) => {
							const ids = changeRows.map((row) => row.dataset_id);
							if (selected) selection.select(ids);
							else selection.deselect(ids);
						},
						columnTitle: (originNode) => <Tooltip title="Selection persists across pages and filters">{originNode}</Tooltip>,
					}}
					locale={{
						emptyText: (
							<div className="py-8 text-center text-gray-500">
								<p className="m-0">No datasets match these filters.</p>
								<Button type="link" onClick={() => setParams(new URLSearchParams())}>
									Clear filters
								</Button>
							</div>
						),
					}}
					pagination={{
						current: page,
						pageSize: FACTORY_PAGE_SIZE,
						total: total ?? (rows.length === FACTORY_PAGE_SIZE ? page * FACTORY_PAGE_SIZE + 1 : page * FACTORY_PAGE_SIZE),
						showSizeChanger: false,
						onChange: setPage,
						showTotal: (count, range) => (total === null ? `${range[0]}-${range[1]}` : `${range[0]}-${range[1]} of ${count}`),
					}}
					scroll={{ x: 1900 }}
				/>
			</div>
		</div>
	);
}
