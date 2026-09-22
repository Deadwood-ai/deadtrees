import { Alert, Button, Segmented, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link, useSearchParams } from "react-router-dom";
import { useFactoryActivity } from "../../hooks/useFactory";
import { FACTORY_PAGE_SIZE, parsePage } from "./factoryFilters";
import { formatUtc } from "./factoryFormat";
import { EmptyNote, FactoryError, Freshness, TimeCell, useNow } from "./FactoryPrimitives";
import { FACTORY_ACTIVITY_KINDS, type FactoryActivityItem, type FactoryActivityKind } from "./factoryTypes";

const { Text } = Typography;

const KIND_LABELS: Record<FactoryActivityKind, string> = {
	all: "All",
	uploads: "Uploads",
	processing: "Processing",
	notifications: "Notifications",
	publications: "Publications",
	reports: "Reports",
};

const KIND_COLORS: Record<string, string | undefined> = {
	uploads: "blue",
	processing: undefined,
	notifications: "purple",
	publications: "green",
	reports: "volcano",
};

const parseKind = (value: string | null): FactoryActivityKind =>
	(FACTORY_ACTIVITY_KINDS as readonly string[]).includes(value ?? "") ? (value as FactoryActivityKind) : "all";

const stateColor = (kind: string, state: string | null): string | undefined => {
	if (!state) return undefined;
	if (/error|failed/i.test(state)) return "red";
	if (/warn/i.test(state)) return "gold";
	if (kind === "uploads") return state === "upload_done" ? "green" : "gold";
	if (kind === "notifications") return state === "sent" ? "green" : state === "skipped" ? "default" : "gold";
	if (kind === "publications") return state === "published" ? "green" : "gold";
	if (kind === "reports") return state === "resolved" ? "green" : "gold";
	return undefined;
};

/** Newest records across uploads, processing logs, notifications, publications and reports. */
export default function FactoryActivity() {
	const [params, setParams] = useSearchParams();
	const kind = parseKind(params.get("kind"));
	const page = parsePage(params);
	const query = useFactoryActivity(kind, page, FACTORY_PAGE_SIZE);
	const now = useNow();

	const update = (nextKind: FactoryActivityKind, nextPage: number) => {
		const next = new URLSearchParams();
		if (nextKind !== "all") next.set("kind", nextKind);
		if (nextPage > 1) next.set("page", String(nextPage));
		setParams(next);
	};

	const columns: ColumnsType<FactoryActivityItem> = [
		{
			title: "Recorded",
			dataIndex: "created_at",
			key: "created_at",
			width: 200,
			render: (value: string | null) => (
				<span className="flex flex-col">
					<TimeCell iso={value} now={now} />
					<span className="text-xs text-gray-400">{formatUtc(value)}</span>
				</span>
			),
		},
		{
			title: "Kind",
			dataIndex: "kind",
			key: "kind",
			width: 130,
			render: (value: string) => <Tag color={KIND_COLORS[value]} className="m-0">{KIND_LABELS[value as FactoryActivityKind] ?? value}</Tag>,
		},
		{
			title: "Dataset",
			dataIndex: "dataset_id",
			key: "dataset_id",
			width: 130,
			render: (value: number | null, row) =>
				value ? (
					<Link to={`/factory/datasets/${value}`} className="font-mono">
						#{value}
					</Link>
				) : (
					<span className="text-xs text-gray-400">{row.kind === "publications" ? `publication ${row.id}` : "—"}</span>
				),
		},
		{
			title: "State",
			dataIndex: "state",
			key: "state",
			width: 130,
			render: (value: string | null, row) => (value ? <Tag color={stateColor(row.kind, value)} className="m-0">{value.replace(/_/g, " ")}</Tag> : <span className="text-gray-400">—</span>),
		},
		{
			title: "Summary",
			dataIndex: "summary",
			key: "summary",
			render: (value: string | null) => <span className="whitespace-pre-wrap text-xs">{value || ""}</span>,
		},
	];

	if (query.isError && !query.data) {
		return <FactoryError error={query.error} onRetry={() => void query.refetch()} title="Could not load activity" />;
	}

	return (
		<div className="space-y-4" data-testid="factory-activity">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<Segmented<FactoryActivityKind>
					value={kind}
					onChange={(value) => update(value, 1)}
					options={FACTORY_ACTIVITY_KINDS.map((value) => ({ value, label: KIND_LABELS[value] }))}
				/>
				<Freshness asOf={query.data?.as_of} isFetching={query.isFetching} onRefresh={() => void query.refetch()} now={now} />
			</div>

			{query.isError && query.data && (
				<Alert type="warning" showIcon message="Activity may be stale" description="The latest refresh failed. Previously loaded rows remain visible." action={<Button onClick={() => void query.refetch()}>Try again</Button>} />
			)}

			<div className="rounded-2xl border border-gray-200/60 bg-white p-4 shadow-sm">
				<Text type="secondary" className="mb-3 block text-xs">
					Each row is a record with its creation time and current state. Upload rows use dataset creation, not upload completion; notification
					and publication rows show the current state, not when it changed.
				</Text>
				{query.data && query.data.items.length === 0 ? (
					<EmptyNote>No {kind === "all" ? "activity" : KIND_LABELS[kind].toLowerCase()} records were returned.</EmptyNote>
				) : (
					<Table
						size="small"
						loading={query.isLoading || query.isPlaceholderData}
						rowClassName={query.isPlaceholderData ? "opacity-50" : undefined}
						dataSource={query.data?.items ?? []}
						columns={columns}
						rowKey={(row) => `${row.kind}-${row.id}`}
						pagination={{
							current: page,
							pageSize: FACTORY_PAGE_SIZE,
							total: query.data?.total ?? (query.data && query.data.items.length === FACTORY_PAGE_SIZE ? page * FACTORY_PAGE_SIZE + 1 : page * FACTORY_PAGE_SIZE),
							showSizeChanger: false,
							onChange: (nextPage) => update(kind, nextPage),
							showTotal: (count, range) => (query.data?.total === null ? `${range[0]}-${range[1]}` : `${range[0]}-${range[1]} of ${count}`),
						}}
						scroll={{ x: 900 }}
					/>
				)}
			</div>
		</div>
	);
}
