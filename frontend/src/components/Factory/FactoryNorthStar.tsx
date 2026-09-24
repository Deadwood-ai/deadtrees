import type { ReactNode } from "react";
import { Alert, Collapse, Skeleton, Switch, Tooltip, Typography } from "antd";
import { ArrowDownOutlined, ArrowUpOutlined, ExportOutlined, InfoCircleOutlined, MinusOutlined } from "@ant-design/icons";
import { Link, useSearchParams } from "react-router-dom";
import { isFactoryPermissionError, useFactoryNorthStar } from "../../hooks/useFactory";
import { POSTHOG_UI_HOST } from "../../utils/analytics";
import FactoryTrendChart, { type TrendBucket, type TrendSeries } from "./FactoryTrendChart";
import { FactoryDenied, FactoryError, Freshness, SectionCard, useNow } from "./FactoryPrimitives";
import { bucketLongLabel, bucketRangeLabel, bucketShortLabel, formatCount, formatHours, TREND_COLORS } from "./factoryTrends";
import {
	STEP_LABELS,
	compare,
	completeWeeks,
	formatPercent,
	formatPoints,
	formatSignedCount,
	latestKnown,
	share,
	sumRecent,
	type Comparison,
	type Direction,
	type FactoryNorthStar as NorthStar,
	type NorthStarCohort,
	type NorthStarWeek,
} from "./factoryNorthStarMetrics";

const { Text } = Typography;

const FUNNEL_WEEKS = 4;

const monthLabel = (iso: string, withYear = true) =>
	new Date(iso).toLocaleDateString("en-GB", { month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });

const weekBuckets = (weeks: NorthStarWeek[], pick: (week: NorthStarWeek) => { n?: number | null; values: Record<string, number | null> }): TrendBucket[] =>
	weeks.map((week) => ({
		key: week.start,
		label: bucketLongLabel(week.start, week.end, "week"),
		shortLabel: bucketShortLabel(week.start),
		complete: !week.partial,
		...pick(week),
	}));

const cohortBuckets = (cohorts: NorthStarCohort[], pick: (cohort: NorthStarCohort) => { n?: number | null; values: Record<string, number | null> }): TrendBucket[] =>
	cohorts.map((cohort) => ({
		key: cohort.start,
		label: `${monthLabel(cohort.start)} cohort (UTC)`,
		shortLabel: monthLabel(cohort.start, false),
		complete: true,
		...pick(cohort),
	}));

const VERDICT_STYLES: Record<Comparison["verdict"], string> = {
	good: "bg-[#EAFAF0] text-[#1B5E35]",
	bad: "bg-red-50 text-red-700",
	flat: "bg-gray-100 text-gray-600",
	unknown: "bg-gray-100 text-gray-500",
};

function Change({ comparison, format, against }: { comparison: Comparison; format: (change: number) => string; against: string }) {
	if (comparison.change === null) {
		return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${VERDICT_STYLES.unknown}`}>no comparison yet</span>;
	}
	const Icon = comparison.change > 0 ? ArrowUpOutlined : comparison.change < 0 ? ArrowDownOutlined : MinusOutlined;
	return (
		<span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${VERDICT_STYLES[comparison.verdict]}`} data-testid="north-star-change" data-verdict={comparison.verdict}>
			<Icon aria-hidden />
			{format(comparison.change)} {against}
		</span>
	);
}

function Hint({ children }: { children: ReactNode }) {
	return (
		<Tooltip title={children}>
			<InfoCircleOutlined className="ml-1 text-xs text-gray-400" aria-label="How this is measured" />
		</Tooltip>
	);
}

function MetricTile({
	title,
	hint,
	value,
	caption,
	change,
	children,
	testId,
}: {
	title: string;
	hint: ReactNode;
	value: string | null;
	caption: ReactNode;
	change: ReactNode;
	children: ReactNode;
	testId: string;
}) {
	return (
		<section className="flex flex-col rounded-2xl border border-gray-200/60 bg-white p-5 shadow-sm" data-testid={testId}>
			<h4 className="m-0 text-sm font-semibold text-gray-700">
				{title}
				<Hint>{hint}</Hint>
			</h4>
			<div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<span className="text-3xl font-semibold text-gray-900" data-testid={`${testId}-value`}>
					{value ?? "—"}
				</span>
				{change}
			</div>
			<Text type="secondary" className="mt-1 block text-xs">
				{caption}
			</Text>
			<div className="mt-3">{children}</div>
		</section>
	);
}

function FunnelStep({ label, unit, value, to, external }: { label: string; unit: string; value: ReactNode; to?: string; external?: boolean }) {
	const content = (
		<>
			<span className="block text-2xl font-semibold text-gray-900">{value}</span>
			<span className="block text-sm text-gray-700">{label}</span>
			<span className="block text-xs text-gray-400">{unit}</span>
		</>
	);
	return (
		<li className="min-w-0 flex-1 rounded-xl bg-[#F8FAF9] px-3 py-3" data-testid="north-star-funnel-step">
			{to && external ? (
				<a href={to} target="_blank" rel="noreferrer" className="block text-inherit hover:text-inherit">
					{content}
				</a>
			) : to ? (
				<Link to={to} className="block text-inherit hover:text-inherit">
					{content}
				</Link>
			) : (
				content
			)}
		</li>
	);
}

const count = (value: number | null) => (value === null ? "—" : formatCount(value));

function Funnel({ data }: { data: NorthStar }) {
	const sum = (pick: (week: NorthStarWeek) => number | null) => sumRecent(data.weekly, pick, FUNNEL_WEEKS);
	return (
		<ol className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4 xl:flex xl:flex-nowrap" aria-label={`Funnel over the last ${FUNNEL_WEEKS} complete weeks`}>
			<FunnelStep
				label="Visitors"
				unit="web analytics"
				value={
					<span className="inline-flex items-center gap-1 text-base font-medium text-[#1B5E35]">
						PostHog <ExportOutlined aria-hidden />
					</span>
				}
				to={`${POSTHOG_UI_HOST}/web`}
				external
			/>
			<FunnelStep label="Signups" unit="accounts" value={count(sum((week) => week.signups))} />
			<FunnelStep label="First-time uploaders" unit="people" value={count(sum((week) => week.first_uploaders))} />
			<FunnelStep label="Uploads" unit="datasets" value={count(sum((week) => week.uploads))} />
			<FunnelStep label="Complete results" unit="datasets" value={count(sum((week) => week.results))} />
			<FunnelStep label="Reference data" unit="datasets audited usable" value={count(sum((week) => week.audited_usable))} />
			<FunnelStep label="Published" unit="datasets" value={count(sum((week) => week.published))} />
		</ol>
	);
}

const pctSeries = (key: string, label: string, color: string): TrendSeries[] => [{ key, label, color }];

function Tiles({ data }: { data: NorthStar }) {
	const { latest, previous } = completeWeeks(data.weekly);
	const weekAgainst = "vs previous week";
	const monthAgainst = "vs previous cohort";

	const activationShare = (cohort: NorthStarCohort) => share(cohort.activated_30d, cohort.activation_eligible);
	const activation = latestKnown(data.cohorts, activationShare);
	const retentionShare = (cohort: NorthStarCohort) => share(cohort.returned_90d, cohort.retention_eligible);
	const retention = latestKnown(data.cohorts, retentionShare);
	const missedShare = (week: NorthStarWeek) => share(week.not_reached_7d, week.reach_eligible);
	const missed = latestKnown(data.weekly, missedShare);

	const tile = (direction: Direction, pick: (week: NorthStarWeek) => number | null) => compare(latest && pick(latest), previous && pick(previous), direction);
	const cohortTile = (direction: Direction, pick: (cohort: NorthStarCohort) => number | null, window: { latest: NorthStarCohort | null; previous: NorthStarCohort | null }) =>
		compare(window.latest && pick(window.latest), window.previous && pick(window.previous), direction);

	const activationChange = cohortTile("up", activationShare, activation);
	const retentionChange = cohortTile("up", retentionShare, retention);
	const missedChange = compare(missed.latest && missedShare(missed.latest), missed.previous && missedShare(missed.previous), "down");
	const speedChange = tile("down", (week) => week.geotiff_p50_hours);
	const reuseChange = tile("up", (week) => week.reuse_downloads);
	const referenceChange = tile("up", (week) => week.audited_usable);

	const weekLabel = latest ? `Week ${bucketRangeLabel(latest.start, latest.end, "week")}` : "No complete week yet";

	return (
		<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
			<MetricTile
				testId="north-star-activation"
				title="Activation · signups who upload within 30 days"
				hint="Share of a month's new accounts that uploaded their first dataset within 30 days. Only accounts older than 30 days count."
				value={activationChange.current === null ? null : formatPercent(activationChange.current)}
				caption={activation.latest ? `${monthLabel(activation.latest.start)} cohort · ${activation.latest.activated_30d} of ${activation.latest.activation_eligible}` : "No elapsed cohort yet"}
				change={<Change comparison={activationChange} format={formatPoints} against={monthAgainst} />}
			>
				<FactoryTrendChart
					kind="points"
					height={150}
					ariaLabel="Activation by signup month"
					format={formatPercent}
					series={pctSeries("share", "Uploaded within 30 days", TREND_COLORS.ready)}
					buckets={cohortBuckets(data.cohorts, (cohort) => ({ n: cohort.activation_eligible, values: { share: activationShare(cohort) } }))}
				/>
			</MetricTile>

			<MetricTile
				testId="north-star-missed"
				title="Uploads with no result within 7 days"
				hint="Share of a week's uploads that had no complete result 7 days later, including results that came late. Grouped by upload week; the latest week appears once 7 days have passed."
				value={missedChange.current === null ? null : formatPercent(missedChange.current)}
				caption={missed.latest ? `Uploaded week ${bucketRangeLabel(missed.latest.start, missed.latest.end, "week")} · ${missed.latest.not_reached_7d} of ${missed.latest.reach_eligible}` : "No upload week has matured yet"}
				change={<Change comparison={missedChange} format={formatPoints} against={weekAgainst} />}
			>
				<FactoryTrendChart
					kind="points"
					height={150}
					ariaLabel="Uploads without a result within 7 days, by upload week"
					format={formatPercent}
					series={pctSeries("share", "No result within 7 days", TREND_COLORS.failed)}
					buckets={weekBuckets(data.weekly, (week) => ({ n: week.reach_eligible, values: { share: missedShare(week) } }))}
				/>
			</MetricTile>

			<MetricTile
				testId="north-star-speed"
				title="Upload to result · GeoTIFF median"
				hint="Time from upload to the first complete result, grouped by the week the result arrived. The dashed lines mark the one-hour target and the two-hour healthy reference. Raw-image ZIPs have no target yet."
				value={speedChange.current === null ? null : formatHours(speedChange.current)}
				caption={
					latest ? (
						<>
							{weekLabel} · GeoTIFF p90 {latest.geotiff_p90_hours === null ? "—" : formatHours(latest.geotiff_p90_hours)} (n {latest.geotiff_samples}) · ZIP median{" "}
							{latest.odm_p50_hours === null ? "—" : formatHours(latest.odm_p50_hours)}, p90 {latest.odm_p90_hours === null ? "—" : formatHours(latest.odm_p90_hours)} (n {latest.odm_samples})
						</>
					) : (
						weekLabel
					)
				}
				change={<Change comparison={speedChange} format={(change) => `${change > 0 ? "+" : "−"}${formatHours(Math.abs(change))}`} against={weekAgainst} />}
			>
				<FactoryTrendChart
					kind="points"
					height={150}
					ariaLabel="GeoTIFF upload-to-result time by result week"
					format={formatHours}
					referenceLines={[
						{ value: 1, label: "1 h target" },
						{ value: 2, label: "2 h" },
					]}
					series={[
						{ key: "p50", label: "GeoTIFF median", color: TREND_COLORS.p50 },
						{ key: "p90", label: "GeoTIFF p90", color: TREND_COLORS.p90 },
					]}
					buckets={weekBuckets(data.weekly, (week) => ({ n: week.geotiff_samples, values: { p50: week.geotiff_p50_hours, p90: week.geotiff_p90_hours } }))}
				/>
			</MetricTile>

			<MetricTile
				testId="north-star-retention"
				title="Contributors who return within 90 days"
				hint="Share of a month's first-time contributors who uploaded again on a later day within 90 days. Only cohorts whose 90 days have passed count."
				value={retentionChange.current === null ? null : formatPercent(retentionChange.current)}
				caption={retention.latest ? `${monthLabel(retention.latest.start)} cohort · ${retention.latest.returned_90d} of ${retention.latest.retention_eligible}` : "No elapsed cohort yet"}
				change={<Change comparison={retentionChange} format={formatPoints} against={monthAgainst} />}
			>
				<FactoryTrendChart
					kind="points"
					height={150}
					ariaLabel="Return within 90 days by first-upload month"
					format={formatPercent}
					series={pctSeries("share", "Returned within 90 days", TREND_COLORS.ready)}
					buckets={cohortBuckets(data.cohorts, (cohort) => ({ n: cohort.retention_eligible, values: { share: retentionShare(cohort) } }))}
				/>
			</MetricTile>

			<MetricTile
				testId="north-star-reuse"
				title="Downloads by other people"
				hint="Accepted download requests (full dataset, labels or bundle) from someone other than the dataset owner. A completed transfer is not observable."
				value={reuseChange.current === null ? null : formatCount(reuseChange.current)}
				caption={latest ? `${weekLabel} · ${latest.downloads === null ? "—" : formatCount(latest.downloads)} requests in total, including owners` : weekLabel}
				change={<Change comparison={reuseChange} format={formatSignedCount} against={weekAgainst} />}
			>
				<FactoryTrendChart
					kind="grouped"
					height={150}
					ariaLabel="Download requests by week"
					format={formatCount}
					series={[
						{ key: "reuse", label: "By other people", color: TREND_COLORS.ready },
						{ key: "owner", label: "By the owner", color: TREND_COLORS.registered },
					]}
					buckets={weekBuckets(data.weekly, (week) => ({
						values: {
							reuse: week.reuse_downloads,
							owner: week.downloads === null || week.reuse_downloads === null ? null : week.downloads - week.reuse_downloads,
						},
					}))}
				/>
			</MetricTile>

			<MetricTile
				testId="north-star-reference"
				title="New reference data"
				hint="Datasets whose audit finished with no issues, by audit date. Fixable and excluded datasets do not count."
				value={referenceChange.current === null ? null : formatCount(referenceChange.current)}
				caption={latest ? `${weekLabel} · ${formatCount(latest.published)} dataset${latest.published === 1 ? "" : "s"} published` : weekLabel}
				change={<Change comparison={referenceChange} format={formatSignedCount} against={weekAgainst} />}
			>
				<FactoryTrendChart
					kind="grouped"
					height={150}
					ariaLabel="Audited usable and published datasets by week"
					format={formatCount}
					series={[
						{ key: "audited", label: "Audited usable", color: TREND_COLORS.ready },
						{ key: "published", label: "Published", color: TREND_COLORS.input },
					]}
					buckets={weekBuckets(data.weekly, (week) => ({ values: { audited: week.audited_usable, published: week.published } }))}
				/>
			</MetricTile>
		</div>
	);
}

function Stalled({ data }: { data: NorthStar }) {
	const total = data.stalled.reduce((sum, row) => sum + row.datasets, 0);
	return (
		<SectionCard title="Where uploads that missed 7 days stand now" count={total} testId="north-star-stalled">
			{total === 0 ? (
				<Text type="secondary">Every upload in the last 12 weeks reached a result within 7 days.</Text>
			) : (
				<ul className="m-0 list-none space-y-2 p-0">
					{data.stalled.map((row) => (
						<li key={row.step} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 text-sm md:grid-cols-[20rem_1fr_auto]" data-testid="north-star-stalled-step">
							<span className="text-gray-700">{STEP_LABELS[row.step] ?? row.step}</span>
							<span className="order-last col-span-2 h-2 rounded-full bg-gray-100 md:order-none md:col-span-1" aria-hidden>
								<span className="block h-2 rounded-full" style={{ width: `${(row.datasets / total) * 100}%`, background: row.step === "late" ? TREND_COLORS.p90 : TREND_COLORS.failed }} />
							</span>
							<span className="whitespace-nowrap text-gray-900">
								{formatCount(row.datasets)}
								{row.with_error > 0 && <span className="ml-1 text-xs text-red-600">({formatCount(row.with_error)} with error)</span>}
							</span>
						</li>
					))}
				</ul>
			)}
			<Text type="secondary" className="mt-3 block text-xs">
				Uploads from the last 12 weeks, grouped by the first required step that is still incomplete.{" "}
				<Link to="/factory/operations">Open Operations</Link> to act on individual datasets.
			</Text>
		</SectionCard>
	);
}

/**
 * The daily question: is DeadTrees turning contributions into trusted, reused data,
 * and is that getting better? Team (auditor) activity is excluded by default.
 */
export default function FactoryNorthStar() {
	const [params, setParams] = useSearchParams();
	const includeTeam = params.get("team") === "include";
	const northStar = useFactoryNorthStar(includeTeam);
	const now = useNow();
	const data = northStar.data;
	const { latest, previous } = data ? completeWeeks(data.weekly) : { latest: null, previous: null };
	const headline = compare(latest?.results, previous?.results, "up");

	const setIncludeTeam = (value: boolean) => {
		const next = new URLSearchParams(params);
		if (value) next.set("team", "include");
		else next.delete("team");
		setParams(next, { replace: true });
	};

	if (isFactoryPermissionError(northStar.error)) {
		return <FactoryDenied />;
	}

	return (
		<div className="space-y-4" data-testid="factory-north-star">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h3 className="m-0 text-lg font-semibold text-gray-900">Is DeadTrees doing its job?</h3>
					<Text type="secondary" className="text-xs">
						Weekly outcomes compared with the week before. The current week is still running and never drives a headline.
					</Text>
				</div>
				<div className="flex flex-wrap items-center gap-4">
					<label className="flex items-center gap-2 text-sm text-gray-700">
						<Switch size="small" checked={includeTeam} onChange={setIncludeTeam} data-testid="north-star-team-toggle" />
						Include team accounts{data ? ` (${data.team_accounts})` : ""}
					</label>
					<Freshness asOf={data?.as_of} isFetching={northStar.isFetching} onRefresh={() => void northStar.refetch()} now={now} />
				</div>
			</div>

			{northStar.isError && data && (
				<Alert type="warning" showIcon message="North-star outcomes may be stale" description="The latest refresh failed. Previously loaded numbers remain visible." />
			)}
			{northStar.isError && !data ? (
				<FactoryError error={northStar.error} onRetry={() => void northStar.refetch()} title="Could not load north-star outcomes" />
			) : !data ? (
				<Skeleton active paragraph={{ rows: 6 }} />
			) : (
				<>
					<div className="grid gap-4 lg:grid-cols-3">
						<section className="rounded-2xl border border-[#1B5E35]/20 bg-white p-5 shadow-sm" data-testid="north-star-headline">
							<h4 className="m-0 text-sm font-semibold text-gray-700">
								Complete results last week
								<Hint>Uploads that reached a finished segmentation for the first time in the week. This is the north-star metric: it should rise week over week.</Hint>
							</h4>
							<div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
								<span className="text-5xl font-semibold text-[#1B5E35]" data-testid="north-star-headline-value">
									{headline.current === null ? "—" : formatCount(headline.current)}
								</span>
								<Change comparison={headline} format={formatSignedCount} against="vs previous week" />
							</div>
							<Text type="secondary" className="mt-1 block text-xs">
								{latest ? `Week ${bucketRangeLabel(latest.start, latest.end, "week")}` : "No complete week yet"}
								{includeTeam ? " · including team" : " · external contributors only"}
							</Text>
							<div className="mt-3">
								<FactoryTrendChart
									kind="grouped"
									height={150}
									ariaLabel="Complete results by week"
									format={formatCount}
									series={[{ key: "results", label: "Complete results", color: TREND_COLORS.ready }]}
									buckets={weekBuckets(data.weekly, (week) => ({ values: { results: week.results } }))}
								/>
							</div>
						</section>
						<section className="rounded-2xl border border-gray-200/60 bg-white p-5 shadow-sm lg:col-span-2" data-testid="north-star-funnel">
							<h4 className="m-0 mb-3 text-sm font-semibold text-gray-700">
								Funnel · last {FUNNEL_WEEKS} complete weeks
								<Hint>Each step counts what happened in these weeks, so steps are flows rather than one cohort moving through. Visitors are only tracked in PostHog.</Hint>
							</h4>
							<Funnel data={data} />
						</section>
					</div>
					<Tiles data={data} />
					<Stalled data={data} />
					<Collapse
						ghost
						items={[
							{
								key: "coverage",
								label: <span className="text-sm text-gray-600">How these numbers are measured</span>,
								children: (
									<ul className="m-0 list-disc space-y-1 pl-5 text-sm text-gray-600" data-testid="factory-north-star-coverage">
										{data.coverage.map((line) => (
											<li key={line}>{line}</li>
										))}
									</ul>
								),
							},
						]}
					/>
				</>
			)}
		</div>
	);
}
