import { useState } from "react";
import { Alert, Select, Skeleton, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link, useSearchParams } from "react-router-dom";
import { useFactoryHistory } from "../../hooks/useFactory";
import { factoryDatasetsPath } from "./factoryFilters";
import { formatUtc } from "./factoryFormat";
import { formatCount, formatHours, formatGib, TREND_COLORS } from "./factoryTrends";
import type { FactoryMetricFilter } from "./factoryTypes";
import type { FactoryHistoryPoint } from "./factoryHistoryTypes";
import FactoryTrendChart, { type TrendBucket, type TrendSeries } from "./FactoryTrendChart";
import { EmptyNote, FactoryError, Freshness, SectionCard, useNow } from "./FactoryPrimitives";

type HistoricalSeries = Omit<TrendSeries, "key"> & { key: Exclude<keyof FactoryHistoryPoint, "start" | "end" | "partial"> };

const { Text } = Typography;
const number = (value: number | null) => value === null ? "—" : formatCount(value);
const duration = (value: number | null) => value === null ? "—" : formatHours(value);

export default function FactoryHistory() {
	const [params, setParams] = useSearchParams();
	const requestedYear = Number(params.get("history_year"));
	const year = Number.isInteger(requestedYear) && requestedYear >= 1970 && requestedYear <= new Date().getUTCFullYear() ? requestedYear : null;
	const setYear = (value: number | null) => {
		const next = new URLSearchParams(params);
		if (value === null) next.delete("history_year"); else next.set("history_year", String(value));
		setParams(next, { replace: true });
	};
	const [selected, setSelected] = useState<string | null>(null);
	const history = useFactoryHistory(year);
	const now = useNow();
	const data = history.data;
	const label = (point: FactoryHistoryPoint) => new Date(point.start).toLocaleDateString("en-GB", {
		year: "numeric", ...(year === null ? {} : { month: "short" as const }), timeZone: "UTC",
	});
	const link = (point: FactoryHistoryPoint, metric: FactoryMetricFilter, value: number | null) => value === null ? "—" : (
		<Link to={factoryDatasetsPath({ metric, metric_after: point.start, metric_before: point.end, archived: "all" })}>{number(value)}</Link>
	);
	const columns: ColumnsType<FactoryHistoryPoint> = [
		{ title: "Period (UTC)", key: "period", fixed: "left", render: (_, p) => `${label(p)}${p.partial ? " · partial" : ""}` },
		{ title: "Registered", key: "registered", render: (_, p) => link(p, "registered", p.registered) },
		{ title: "Uploads observed", key: "uploaded", render: (_, p) => link(p, "historical_uploaded", p.uploaded) },
		{ title: "Contributors", dataIndex: "contributors", render: number },
		{ title: "Returning contributors¹", dataIndex: "returning_contributors", render: number },
		{ title: "Completed runs", key: "completed", render: (_, p) => link(p, "recorded_completed", p.completed) },
		{ title: "With indexing", key: "indexing", render: (_, p) => link(p, "recorded_embedding_completed", p.indexing) },
		{ title: "Failed runs", key: "failed", render: (_, p) => link(p, "recorded_failed", p.failed) },
		{ title: "Email recipients sent", key: "emails", render: (_, p) => link(p, "historical_email", p.emails) },
		{ title: "Reports submitted", key: "reports", render: (_, p) => link(p, "historical_report", p.reports) },
		{ title: "Publications", dataIndex: "publications", render: number },
		{ title: "Uploaded GiB", dataIndex: "input_gib", render: (n: number | null) => n === null ? "—" : formatGib(n) },
		{ title: "Known sizes", dataIndex: "size_samples", render: number },
		{ title: "Recorded completion p50²", dataIndex: "p50", render: duration },
		{ title: "p90²", dataIndex: "p90", render: duration },
		{ title: "Timing samples", key: "timing", render: (_, p) => link(p, "historical_completion", p.timing_samples) },
	];
	const chart = (title: string, series: HistoricalSeries[], format = formatCount, timing = false) => {
		const buckets: TrendBucket[] = (data?.series ?? []).map((p) => ({
			key: p.start, label: `${label(p)} (UTC)`, shortLabel: label(p), complete: !p.partial,
			...(timing ? { n: p.timing_samples } : {}),
			values: Object.fromEntries(series.map((s) => [s.key, p[s.key]])),
		}));
		return <div><h4 className="mb-2 font-semibold">{title}</h4><FactoryTrendChart kind={timing ? "points" : "grouped"} ariaLabel={title} buckets={buckets} series={series} format={format} selectedKey={selected} onSelect={setSelected} /></div>;
	};
	return (
		<SectionCard title="Historical platform activity" testId="factory-historical-activity">
			<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
				<Select aria-label="Historical year" value={year ?? "all"} className="w-56" options={[
					{ value: "all", label: "All history · by year" }, ...(data?.years ?? []).map((y) => ({ value: y, label: `${y} · by month` })),
				]} onChange={(value) => { setYear(value === "all" ? null : Number(value)); setSelected(null); }} />
				<Freshness asOf={data?.as_of} isFetching={history.isFetching} onRefresh={() => void history.refetch()} now={now} />
			</div>
			{history.isError && <FactoryError error={history.error} onRetry={() => void history.refetch()} title="Historical activity could not be refreshed" />}
			{history.isLoading && <Skeleton active />}
			{data && <>
				<div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="factory-history-coverage">
					<div><Text type="secondary">Ready now · unarchived</Text><div className="text-2xl font-semibold"><Link to={factoryDatasetsPath({ ready: true })}>{number(data.coverage.ready_now)}</Link></div></div>
					<div><Text type="secondary">Retained datasets · includes archived</Text><div className="text-2xl font-semibold">{number(data.coverage.datasets)}</div></div>
					<div><Text type="secondary">Upload timestamps found</Text><div className="text-2xl font-semibold">{number(data.coverage.upload_evidence)} / {number(data.coverage.datasets)}</div></div>
					<div><Text type="secondary">Upload + recorded completion pairs</Text><div className="text-2xl font-semibold">{number(data.coverage.timing_pairs)} / {number(data.coverage.upload_evidence)}</div></div>
				</div>
				<Alert type="info" showIcon className="mb-4" message="Historical evidence has uneven coverage" description={<>
					Registrations from {formatUtc(data.first_registration)}. Upload evidence from {formatUtc(data.upload_since)}; recorded run outcomes from {formatUtc(data.run_since)}.
					Email evidence from {formatUtc(data.email_since)}, reports from {formatUtc(data.report_since)}, publications from {formatUtc(data.publication_since)}. Earlier unsupported periods stay unknown. Counts after those dates show retained records, not guaranteed complete coverage. Deleted records are absent.
					All history is global; workflow and size controls for directly measured outcomes do not filter this section.
				</>} />
				{data.series.length === 0 ? <EmptyNote>No historical intervals were returned.</EmptyNote> : <div className="grid gap-6 lg:grid-cols-2">
					{chart("Registrations and observed uploads", [{ key: "registered", label: "Registrations", color: TREND_COLORS.registered }, { key: "uploaded", label: "Uploads observed", color: TREND_COLORS.uploaded }])}
					{chart("Recorded processing runs · includes reruns", [{ key: "completed", label: "Completed", color: TREND_COLORS.recordedCompleted }, { key: "indexing", label: "Completed with indexing (subset)", color: TREND_COLORS.recordedEmbedding }, { key: "failed", label: "Failed", color: TREND_COLORS.recordedFailed }])}
					{chart("Delivery, reports and publications", [{ key: "emails", label: "Email recipients sent", color: TREND_COLORS.input }, { key: "reports", label: "Reports submitted", color: TREND_COLORS.p90 }, { key: "publications", label: "Publications", color: TREND_COLORS.ready }])}
					{chart("Contributors with observed uploads", [{ key: "contributors", label: "Contributors", color: TREND_COLORS.registered }, { key: "returning_contributors", label: "Returning (subset)", color: TREND_COLORS.ready }])}
					{chart("Uploaded input volume · known sizes only", [{ key: "input_gib", label: "Uploaded GiB", color: TREND_COLORS.input }], formatGib)}
					{chart("Recorded completion delay² · not processing latency", [{ key: "p50", label: "p50", color: TREND_COLORS.p50 }, { key: "p90", label: "p90", color: TREND_COLORS.p90 }], formatHours, true)}
				</div>}
				<Alert type="warning" showIcon className="mt-4" message="Historical timing is diagnostic, not a processing-speed KPI" description="The first retained completion may be a rerun months after the original result. This delay must not be compared with the directly measured first-result latency below." />
				<Text className="my-4 block" type="secondary">Select a chart period to narrow the table; select it again to show all periods. Linked counts open the matching distinct datasets. Run, report and email counts can exceed the number of datasets.</Text>
				<Table data-testid="factory-history-table" size="small" rowKey="start" columns={columns} dataSource={data.series.filter((p) => !selected || p.start === selected)} pagination={false} scroll={{ x: 2300 }} />
				<Text type="secondary" className="mt-4 block text-xs">¹ Contributors with an observed upload before this period; not proof of their first-ever upload or a retention rate.
					² Elapsed time from an evidenced upload to the earliest retained completion notification, grouped by completion date. That notification may describe a rerun, so this is not measured first-result latency. Missing or reversed timestamp pairs are excluded.
					Upload timestamps include {number(data.coverage.measured_uploads)} directly measured and {number(data.coverage.upload_evidence - data.coverage.measured_uploads)} reconstructed from upload logs. Original upload sizes are known for {number(data.coverage.upload_sizes)} datasets. Current output sizes are never substituted. Historical queue sizes, complete failure-recovery episodes and owner visits cannot be recovered from these records.</Text>
			</>}
		</SectionCard>
	);
}
