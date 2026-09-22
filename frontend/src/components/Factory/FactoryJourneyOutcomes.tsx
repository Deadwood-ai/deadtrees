import { Skeleton, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { formatUtc } from "./factoryFormat";
import { TREND_COLORS, bucketLongLabel, bucketShortLabel, formatCount, formatShare } from "./factoryTrends";
import FactoryTrendChart from "./FactoryTrendChart";
import { EmptyNote, FactoryError, SectionCard } from "./FactoryPrimitives";
import type { FactoryJourney, FactoryJourneyCohort } from "./factoryTypes";

const { Text } = Typography;

type FactoryJourneyOutcomesProps = {
	journey: FactoryJourney | undefined;
	isLoading: boolean;
	error: unknown;
	onRetry: () => void;
};

/** What happens after a result: observed first views, repeat contributions and publications, all global. */
export default function FactoryJourneyOutcomes({ journey, isLoading, error, onRetry }: FactoryJourneyOutcomesProps) {
	if (error && !journey) {
		return (
			<SectionCard title="After the result" testId="factory-journey-outcomes">
				<FactoryError error={error} onRetry={onRetry} title="Could not load journey outcomes" />
			</SectionCard>
		);
	}
	if (isLoading || !journey) {
		return (
			<SectionCard title="After the result" testId="factory-journey-outcomes">
				<Skeleton active paragraph={{ rows: 5 }} />
			</SectionCard>
		);
	}

	const weekly = journey.weekly.map((week) => ({
		key: week.start,
		label: bucketLongLabel(week.start, week.end, "week"),
		shortLabel: bucketShortLabel(week.start),
		complete: !week.partial,
		values: {
			uploads: week.uploads,
			first_ready: week.first_ready,
			observed_views: week.observed_views,
			publications: week.publications,
		},
	}));

	const cohortColumns: ColumnsType<FactoryJourneyCohort> = [
		{
			title: "First upload week",
			dataIndex: "week",
			key: "week",
			render: (value: string) => <span className="font-mono text-xs">{value?.slice(0, 10) || "unknown"}</span>,
		},
		{
			title: "New contributors",
			dataIndex: "contributors",
			key: "contributors",
			align: "right",
			render: (value: number | null) => (value === null ? "unknown" : value),
		},
		{
			title: "Saw first result within 7 days",
			key: "activated",
			render: (_, row) => formatShare(row.activated_7d, row.activation_eligible),
		},
		{
			title: "Uploaded again within 30 days",
			key: "returned",
			render: (_, row) => formatShare(row.returned_30d, row.retention_eligible),
		},
	];

	return (
		<SectionCard title="After the result: activation, retention, impact" testId="factory-journey-outcomes">
			<Text type="secondary" className="mb-2 block text-xs">
				Global weekly counts for the whole platform; the trend filters above do not apply here. Observed first views count consented owner
				visits only, so they are a lower bound: a missing view is not evidence the result went unseen. Views are tracked
				{journey.activation_tracking_since ? ` since ${formatUtc(journey.activation_tracking_since)}` : " from an unknown date"}, uploads and
				results{journey.tracking_since ? ` since ${formatUtc(journey.tracking_since)}` : " from an unknown date"}; earlier weeks show “?”.
			</Text>
			{weekly.length === 0 ? (
				<EmptyNote>No weekly journey rows were returned.</EmptyNote>
			) : (
				<FactoryTrendChart
					kind="grouped"
					ariaLabel="Uploads, first results, observed first views and publications per week"
					buckets={weekly}
					series={[
						{ key: "uploads", label: "Uploads completed", color: TREND_COLORS.uploaded },
						{ key: "first_ready", label: "First results", color: TREND_COLORS.ready },
						{ key: "observed_views", label: "Observed first views (lower bound)", color: TREND_COLORS.p50 },
						{ key: "publications", label: "Publications", color: TREND_COLORS.registered },
					]}
					format={formatCount}
					height={200}
				/>
			)}

			<h4 className="mb-1 mt-5 text-sm font-semibold text-gray-900">Contributor cohorts</h4>
			<Text type="secondary" className="mb-2 block text-xs">
				First-ever tracked contributors from the last 26 calendar weeks, grouped by their first upload week. Each outcome counts only contributors whose window has fully
				elapsed, so the same people are compared over the same time. A share appears once at least five are eligible.
			</Text>
			{journey.cohorts.length === 0 ? (
				<EmptyNote>No contributor cohorts yet. Cohorts start with the first contributor tracked after measurement began.</EmptyNote>
			) : (
				<Table size="small" pagination={false} dataSource={journey.cohorts} columns={cohortColumns} rowKey="week" scroll={{ x: 560 }} data-testid="factory-journey-cohorts" />
			)}

		</SectionCard>
	);
}
