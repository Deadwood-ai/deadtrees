import { useEffect, useState } from "react";
import { Badge, Button, Checkbox, Collapse, DatePicker, Input, Select, Tag, Typography } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { countActiveFilters, parseIdList } from "./factoryFilters";
import { formatUtc, stateLabel } from "./factoryFormat";
import {
	FACTORY_NOTIFICATION_FILTERS,
	FACTORY_PUBLICATION_FILTERS,
	FACTORY_STATES,
	type FactoryFilters,
} from "./factoryTypes";

const { Text } = Typography;

type FactoryDatasetFiltersProps = {
	filters: FactoryFilters;
	onChange: (next: FactoryFilters) => void;
	onReset: () => void;
};

const NOTIFICATION_LABELS: Record<string, string> = {
	problem: "Problem (failed or overdue)",
	none: "No record",
	sent: "Sent",
	failed: "Failed",
	pending: "Pending",
	sending: "Sending",
	skipped: "Skipped",
};

const METRIC_LABELS: Record<string, string> = {
	historical_uploaded: "uploads with historical evidence",
	historical_completion: "first recorded completions with upload evidence",
	historical_report: "submitted reports",
	historical_email: "sent notification recipients",
	uploaded: "uploads completed",
	first_ready: "first complete results",
	failures: "failure episodes",
	recovered: "recovered failures",
	registered: "registered datasets",
	recorded_completed: "recorded completions",
	recorded_failed: "recorded failures",
	recorded_embedding_completed: "completions with search indexing",
	waiting: "still waiting",
	failed_submission: "waiting with a failure",
	overdue: "overdue (soft)",
	unresolved_failure: "unresolved failures",
};
const SIZE_LABELS: Record<string, string> = { small: "under 1 GiB", large: "1 GiB and above", unknown: "not measured" };

const triState = (value: boolean | undefined): "any" | "yes" | "no" => (value === undefined ? "any" : value ? "yes" : "no");
const fromTriState = (value: "any" | "yes" | "no"): boolean | undefined => (value === "any" ? undefined : value === "yes");

function Field({ label, children, width }: { label: string; children: React.ReactNode; width?: number | string }) {
	return (
		<div style={{ width }}>
			<Text type="secondary" className="mb-1 block text-xs">
				{label}
			</Text>
			{children}
		</div>
	);
}

/** URL-backed filter bar. Text inputs apply on enter or blur; everything else applies immediately. */
export default function FactoryDatasetFilters({ filters, onChange, onReset }: FactoryDatasetFiltersProps) {
	const [search, setSearch] = useState(filters.search ?? "");
	const [worker, setWorker] = useState(filters.worker ?? "");
	const [contributor, setContributor] = useState(filters.contributor ?? "");
	const [idsText, setIdsText] = useState(filters.ids?.join(", ") ?? "");

	useEffect(() => setSearch(filters.search ?? ""), [filters.search]);
	useEffect(() => setWorker(filters.worker ?? ""), [filters.worker]);
	useEffect(() => setContributor(filters.contributor ?? ""), [filters.contributor]);
	useEffect(() => setIdsText(filters.ids?.join(", ") ?? ""), [filters.ids]);

	const set = <K extends keyof FactoryFilters>(key: K, value: FactoryFilters[K]) => {
		const next = { ...filters };
		if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
			delete next[key];
		} else {
			next[key] = value;
		}
		onChange(next);
	};

	const dateRange: [Dayjs | null, Dayjs | null] = [
		filters.created_after ? dayjs(filters.created_after) : null,
		filters.created_before ? dayjs(filters.created_before).subtract(1, "millisecond") : null,
	];

	const activeCount = countActiveFilters(filters);
	const ledgerChips: { key: "metric" | "workflow" | "size"; label: string }[] = [];
	if (filters.metric) {
		const window =
			filters.metric_after || filters.metric_before
				? ` ${filters.metric_after ? formatUtc(filters.metric_after) : "…"} to ${filters.metric_before ? formatUtc(filters.metric_before) : "…"}`
				: "";
		ledgerChips.push({ key: "metric", label: `Ledger: ${METRIC_LABELS[filters.metric] ?? filters.metric}${window}` });
	}
	if (filters.workflow) ledgerChips.push({ key: "workflow", label: `Workflow: ${filters.workflow === "odm" ? "raw image ZIPs" : "GeoTIFF uploads"}` });
	if (filters.size) ledgerChips.push({ key: "size", label: `Size: ${SIZE_LABELS[filters.size] ?? filters.size}` });
	const clearLedger = (key: "metric" | "workflow" | "size") => {
		const next = { ...filters };
		if (key === "metric") {
			delete next.metric;
			delete next.metric_after;
			delete next.metric_before;
		} else {
			delete next[key];
		}
		onChange(next);
	};
	const advancedActive = [filters.contributor, filters.ids, filters.uploaded, filters.has_audit, filters.ready, filters.worker].some(
		(value) => value !== undefined
	);

	return (
		<div className="rounded-2xl border border-gray-200/60 bg-white p-4 shadow-sm" data-testid="factory-filters">
			{ledgerChips.length > 0 && (
				<div className="mb-3 flex flex-wrap items-center gap-2" data-testid="factory-ledger-chips">
					{ledgerChips.map((chip) => (
						<Tag key={chip.key} closable onClose={() => clearLedger(chip.key)} color="green" className="m-0">
							{chip.label}
						</Tag>
					))}
				</div>
			)}
			<div className="flex flex-wrap items-end gap-3">
				<Field label="Search" width={280}>
					<Input.Search
						allowClear
						placeholder="ID, file name, contributor email or organisation"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						onSearch={(value) => set("search", value.trim() || undefined)}
						onBlur={() => {
							if ((search.trim() || undefined) !== filters.search) set("search", search.trim() || undefined);
						}}
					/>
				</Field>
				<Field label="State" width={170}>
					<Select
						allowClear
						placeholder="All states"
						value={filters.state}
						onChange={(value) => set("state", value)}
						options={FACTORY_STATES.map((state) => ({ value: state, label: stateLabel(state) }))}
					/>
				</Field>
				<Field label="Delivery" width={210}>
					<Select
						allowClear
						placeholder="Any delivery state"
						value={filters.notification}
						onChange={(value) => set("notification", value)}
						options={FACTORY_NOTIFICATION_FILTERS.map((value) => ({ value, label: NOTIFICATION_LABELS[value] ?? value }))}
					/>
				</Field>
				<Field label="Publication" width={170}>
					<Select
						allowClear
						placeholder="Any"
						value={filters.publication}
						onChange={(value) => set("publication", value)}
						options={FACTORY_PUBLICATION_FILTERS.map((value) => ({ value, label: value.replace("_", " ") }))}
					/>
				</Field>
				<Field label="Created (UTC)" width={260}>
					<DatePicker.RangePicker
						allowEmpty={[true, true]}
						value={dateRange}
						onChange={(range) => {
							const [start, end] = range ?? [null, null];
							onChange({
								...filters,
								created_after: start ? start.startOf("day").toISOString() : undefined,
								created_before: end ? end.add(1, "day").startOf("day").toISOString() : undefined,
							});
						}}
					/>
				</Field>
				<Field label="Archived" width={140}>
					<Select
						value={filters.archived ?? "no"}
						onChange={(value) => set("archived", value === "no" ? undefined : value)}
						options={[
							{ value: "no", label: "Hidden" },
							{ value: "yes", label: "Only archived" },
							{ value: "all", label: "Included" },
						]}
					/>
				</Field>
				<div className="flex items-center gap-4 pb-1">
					<Checkbox checked={filters.reports === "open"} onChange={(event) => set("reports", event.target.checked ? "open" : undefined)}>
						Open reports
					</Checkbox>
					<Checkbox checked={filters.attention === true} onChange={(event) => set("attention", event.target.checked ? true : undefined)}>
						Needs attention
					</Checkbox>
				</div>
				<Button onClick={onReset} disabled={activeCount === 0}>
					Reset {activeCount > 0 && <Badge count={activeCount} size="small" color="#6B7280" className="ml-1" />}
				</Button>
			</div>

			<Collapse
				ghost
				className="mt-2 -mx-2"
				defaultActiveKey={advancedActive ? ["advanced"] : []}
				items={[
					{
						key: "advanced",
						label: <span className="text-sm text-gray-600">More filters</span>,
						children: (
							<div className="flex flex-wrap items-end gap-3">
								<Field label="Worker" width={200}>
									<Input
										allowClear
										placeholder="Worker ID"
										value={worker}
										onChange={(event) => setWorker(event.target.value)}
										onPressEnter={() => set("worker", worker.trim() || undefined)}
										onBlur={() => {
											if ((worker.trim() || undefined) !== filters.worker) set("worker", worker.trim() || undefined);
										}}
									/>
								</Field>
								<Field label="Contributor (user ID)" width={300}>
									<Input
										allowClear
										placeholder="UUID"
										value={contributor}
										onChange={(event) => setContributor(event.target.value)}
										onPressEnter={() => set("contributor", contributor.trim() || undefined)}
										onBlur={() => {
											if ((contributor.trim() || undefined) !== filters.contributor) set("contributor", contributor.trim() || undefined);
										}}
									/>
								</Field>
								<Field label="Dataset IDs" width={300}>
									<Input
										allowClear
										placeholder="671, 10494"
										value={idsText}
										onChange={(event) => setIdsText(event.target.value)}
										onPressEnter={() => set("ids", parseIdList(idsText))}
										onBlur={() => {
											const ids = parseIdList(idsText);
											if (ids.join(",") !== (filters.ids ?? []).join(",")) set("ids", ids);
										}}
									/>
								</Field>
								<Field label="Upload done" width={120}>
									<Select value={triState(filters.uploaded)} onChange={(value) => set("uploaded", fromTriState(value))} options={[{ value: "any", label: "Any" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
								</Field>
								<Field label="Audit record" width={120}>
									<Select value={triState(filters.has_audit)} onChange={(value) => set("has_audit", fromTriState(value))} options={[{ value: "any", label: "Any" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
								</Field>
								<Field label="Ready flag" width={120}>
									<Select value={triState(filters.ready)} onChange={(value) => set("ready", fromTriState(value))} options={[{ value: "any", label: "Any" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
								</Field>
							</div>
						),
					},
				]}
			/>
		</div>
	);
}
