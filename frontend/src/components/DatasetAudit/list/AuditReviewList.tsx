import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Collapse, Segmented, Select, Switch, Table, Tag, Typography } from "antd";
import { FilterOutlined } from "@ant-design/icons";
import { useAuditNavigation } from "../../../hooks/useAuditNavigation";
import { useAnalytics } from "../../../hooks/useAnalytics";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { useAuditListOptions, useAuditListPage, useAuditTabCounts } from "../../../hooks/useAuditReviewList";
import {
	NEWEST_FIRST,
	TABS,
	activeFilterCount,
	filtersFromParams,
	listParams,
	tabOf,
	type AuditListTab,
	type IAuditListFilters,
	type IListSort,
} from "../../../utils/auditReviewList";
import StatusPage from "../../StatusPage";
import BenchmarkTab from "../benchmark/BenchmarkTab";
import AuditListFilters from "./AuditListFilters";
import LegacyAuditList from "./LegacyAuditList";
import { auditListColumns } from "./auditListColumns";

const { Title, Text } = Typography;

const PAGE_SIZE = 50;

/** The processing stage columns are shown or not, as each auditor last left them. */
const STAGES_KEY = "audit-review-processing-stages";
function storedShowStages(): boolean {
	try {
		return localStorage.getItem(STAGES_KEY) === "1";
	} catch {
		return false;
	}
}
function storeShowStages(show: boolean) {
	try {
		localStorage.setItem(STAGES_KEY, show ? "1" : "0");
	} catch {
		// the switch still works for this page
	}
}

/** The legacy manual audits: a list of its own in the other group, ?view=legacy. */
const LEGACY = "legacy";
type ListChoice = AuditListTab | typeof LEGACY;

const DESCRIPTIONS: Record<ListChoice, string> = {
	all: "Every dataset, at any processing stage, with what each check reports.",
	pending: "Datasets where a check needs a person: open one and answer the steps marked “Review required”.",
	benchmark: "The labels the checks are scored on: label new random tiles or datasets, each joins its benchmark with your label.",
	"edits-flags": "Datasets with suggested corrections to predictions or issue reports from users that still need a decision. They are not part of the audit.",
	reference: "Datasets selected for the segmentation benchmark. Open one to manage its reference patches.",
	legacy: "Read-only. The audit form saved these before the Audit Review; their decisions count as earlier evaluation decisions.",
};

const GROUPS: { title: string; choices: { value: ListChoice; label: string; chip: boolean }[] }[] = [
	{ title: "Audit Review", choices: TABS.filter((t) => t.group === "review").map((t) => ({ value: t.key, label: t.label, chip: !!t.chip })) },
	{
		title: "Other",
		choices: [
			...TABS.filter((t) => t.group === "other").map((t) => ({ value: t.key, label: t.label, chip: !!t.chip })),
			{ value: LEGACY, label: "Legacy Manual Audits", chip: false },
		],
	},
];

/** The Audit Review list: the Audit Review's tabs (All audits, Pending audit reviews, Benchmark)
 * and, apart from them, the other lists (Edits & flags, Segmentation Benchmark, the legacy manual
 * audits). Each tab is the same table with a fixed chip and the filters. Tab and filters live in
 * the URL. */
export default function AuditReviewList({ notice }: { notice?: ReactNode }) {
	const navigate = useNavigate();
	const isMobile = useIsMobile();
	const { track } = useAnalytics("audit");
	const [searchParams, setSearchParams] = useSearchParams();
	const { setListPath } = useAuditNavigation();
	const legacy = searchParams.get("view") === "legacy";
	const [tab, setTab] = useState<AuditListTab>(() => tabOf(searchParams.get("tab")));
	const [filters, setFilters] = useState<IAuditListFilters>(() => filtersFromParams(searchParams));
	const [filtersOpen, setFiltersOpen] = useState(() => activeFilterCount(filtersFromParams(searchParams)) > 0);
	const [sort, setSort] = useState<IListSort>(NEWEST_FIRST);
	const [paging, setPaging] = useState({ page: 1, size: PAGE_SIZE });
	const [showStages, setShowStages] = useState(storedShowStages);
	const list = useAuditListPage(tab, filters, sort, paging.page, paging.size);
	const { data: counts = {} } = useAuditTabCounts();
	const { data: options } = useAuditListOptions();
	// another tab, filter or sort starts again on the first page
	const firstPage = () => setPaging((p) => ({ ...p, page: 1 }));

	useEffect(() => {
		if (legacy) return;
		const params = listParams(tab, filters);
		setSearchParams(params, { replace: true });
		setListPath(`/dataset-audit?${params}`);
	}, [legacy, tab, filters, setSearchParams, setListPath]);

	useEffect(() => {
		track("audit_queue_viewed", { audit_tab: legacy ? "legacy" : tab });
	}, [legacy, tab, track]);

	const current = TABS.find((t) => t.key === tab)!;
	const choice: ListChoice = legacy ? LEGACY : tab;
	const choose = (value: ListChoice) => {
		if (value === LEGACY) return setSearchParams({ view: LEGACY });
		setTab(value);
		firstPage();
		// leaving the legacy list: the effect above writes the tab's params from here on
		if (legacy) setSearchParams(listParams(value, filters), { replace: true });
	};
	const columns = auditListColumns({
		tab,
		sort,
		showStages,
		// the edits and user reports have their own page; they are not part of the audit
		onOpen:
			tab === "edits-flags"
				? (id) => navigate(`/dataset-audit/${id}/edits-flags`)
				: (id) => {
						track("audit_started", { dataset_id: id });
						navigate(`/dataset-audit/${id}`);
					},
		onReferencePatches: tab === "reference" ? (id) => navigate(`/dataset-audit/${id}/reference-patches`) : undefined,
	});

	if (list.isError) {
		return (
			<StatusPage
				kind="offline"
				title="The Audit Review list couldn’t load"
				description="DeadTrees didn’t respond. Check your connection and try again in a moment."
				actions={
					<Button type="primary" onClick={() => list.refetch()}>
						Try again
					</Button>
				}
			/>
		);
	}

	const choiceLabel = (c: (typeof GROUPS)[number]["choices"][number]) => {
		const count = counts[c.value as AuditListTab];
		return c.chip && count !== undefined ? `${c.label} (${count})` : c.label;
	};
	const filterCount = activeFilterCount(filters);

	return (
		<div className="min-h-[calc(100vh-64px)] w-full bg-[#F8FAF9] pb-24 pt-24 md:pt-28">
			<div className="mx-auto max-w-[1920px] px-4 md:px-8 xl:px-12">
				{notice}
				{isMobile ? (
					<Select
						value={choice}
						onChange={choose}
						className="mb-2 w-full"
						options={GROUPS.map((g) => ({ label: g.title, options: g.choices.map((c) => ({ label: choiceLabel(c), value: c.value })) }))}
					/>
				) : (
					<div className="mb-2 flex flex-wrap items-end gap-x-10 gap-y-4">
						{GROUPS.map((group, i) => (
							<div key={group.title} className={i > 0 ? "border-l border-gray-300 pl-10" : ""} data-testid={`audit-list-group-${i}`}>
								<Title level={2} style={{ margin: "0 0 12px", fontWeight: 700 }}>
									{group.title}
								</Title>
								<Segmented
									value={choice}
									onChange={(value) => choose(value as ListChoice)}
									size="large"
									className="border border-gray-200/50 shadow-sm"
									options={group.choices.map((c) => ({ label: <span className="px-2 py-1">{choiceLabel(c)}</span>, value: c.value }))}
								/>
							</div>
						))}
					</div>
				)}
				<Text type="secondary" className="mb-6 block text-sm">
					{DESCRIPTIONS[choice]}
				</Text>

				{legacy ? (
					<div className="rounded-2xl border border-gray-200/60 bg-white p-6 shadow-sm">
						<LegacyAuditList />
					</div>
				) : (
					<>
						<div className="rounded-2xl border border-gray-200/60 bg-white p-6 shadow-sm">
							{tab === "benchmark" ? (
								<BenchmarkTab />
							) : (
								<>
									<div className="mb-3 flex flex-wrap items-center gap-2">
										<span className="flex flex-wrap items-center gap-2" data-testid="audit-list-count">
											{current.chip && (
												<Tag color="blue" className="m-0">
													{current.chip}
												</Tag>
											)}
											<Text className="text-sm">
												{list.data?.total ?? "…"} of {counts.all ?? "…"} datasets
											</Text>
										</span>
										<span className="ml-auto flex items-center gap-2 text-sm">
											<Switch
												size="small"
												checked={showStages}
												onChange={(show) => {
													setShowStages(show);
													storeShowStages(show);
												}}
												aria-label="Processing stages"
											/>
											Processing stages
										</span>
									</div>
									<Collapse
										className="mb-4"
										activeKey={filtersOpen ? ["filters"] : []}
										onChange={() => setFiltersOpen((open) => !open)}
										items={[
											{
												key: "filters",
												label: (
													<span>
														<FilterOutlined /> Filters{filterCount ? ` (${filterCount})` : ""}
													</span>
												),
												children: (
													<AuditListFilters
														filters={filters}
														onChange={(patch) => {
															setFilters((f) => ({ ...f, ...patch }));
															firstPage();
														}}
														countries={options?.countries ?? []}
														stages={options?.stages ?? []}
														reviewers={options?.reviewers ?? []}
													/>
												),
											},
										]}
									/>
									<Table
										dataSource={list.data?.rows}
										columns={columns}
										rowKey="dataset_id"
										size="small"
										loading={list.isFetching}
										pagination={{
											current: paging.page,
											pageSize: paging.size,
											total: list.data?.total ?? 0,
											showSizeChanger: true,
											showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} datasets`,
										}}
										onChange={(pagination, _filters, sorter, { action }) => {
											if (action === "sort") {
												const sorted = Array.isArray(sorter) ? sorter[0] : sorter;
												setSort(sorted?.order && sorted.columnKey ? { key: String(sorted.columnKey), ascending: sorted.order === "ascend" } : NEWEST_FIRST);
												firstPage();
											} else setPaging({ page: pagination.current ?? 1, size: pagination.pageSize ?? PAGE_SIZE });
										}}
										scroll={{ x: showStages ? 2700 : 1500 }}
										data-testid="audit-review-table"
									/>
								</>
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
