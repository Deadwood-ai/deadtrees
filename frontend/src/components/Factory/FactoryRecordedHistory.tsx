import { Typography } from "antd";
import { formatUtc } from "./factoryFormat";
import { TREND_COLORS, formatCount, toTrendBuckets } from "./factoryTrends";
import FactoryTrendChart from "./FactoryTrendChart";
import { EmptyNote, SectionCard } from "./FactoryPrimitives";
import type { FactoryTrends } from "./factoryTypes";

const { Text } = Typography;

type FactoryRecordedHistoryProps = {
	trends: FactoryTrends;
	selectedKey: string | null;
	onSelect: (key: string | null) => void;
};

/**
 * Historical evidence that exists for every interval: datasets registered, and
 * outcomes the notification ledger recorded. It is activity, not upload-to-result timing.
 */
export default function FactoryRecordedHistory({ trends, selectedKey, onSelect }: FactoryRecordedHistoryProps) {
	const buckets = toTrendBuckets(trends.series, trends.interval, (point) => ({
		values: {
			registered: point.registered,
			recorded_completed: point.recorded_completed,
			recorded_failed: point.recorded_failed,
			recorded_embedding_completed: point.recorded_embedding_completed,
		},
	}));
	return (
		<SectionCard title="Recorded activity" testId="factory-recorded-history">
			<Text type="secondary" className="mb-2 block text-xs">
				Datasets registered per interval, and completion or failure notifications recorded per task and event. Recording exists only for runs
				processed while notifications were enabled, so coverage is conditional and gaps are missing records, not quiet periods. Registration is
				not a completed upload, a recorded completion is not a first complete result, and “with search indexing” describes the task mix, not why
				the run happened.
				{trends.tracking_since && <> Measured outcomes above begin {formatUtc(trends.tracking_since)}.</>}
			</Text>
			{trends.series.length === 0 ? (
				<EmptyNote>No intervals were returned.</EmptyNote>
			) : (
				<FactoryTrendChart
					kind="grouped"
					ariaLabel="Registered datasets and recorded outcomes per interval"
					buckets={buckets}
					series={[
						{ key: "registered", label: "Registered", color: TREND_COLORS.registered },
						{ key: "recorded_completed", label: "Recorded completion", color: TREND_COLORS.recordedCompleted },
						{ key: "recorded_failed", label: "Recorded failure", color: TREND_COLORS.recordedFailed },
						{ key: "recorded_embedding_completed", label: "Completion with search indexing", color: TREND_COLORS.recordedEmbedding },
					]}
					format={formatCount}
					selectedKey={selectedKey}
					onSelect={onSelect}
					height={190}
				/>
			)}
		</SectionCard>
	);
}
