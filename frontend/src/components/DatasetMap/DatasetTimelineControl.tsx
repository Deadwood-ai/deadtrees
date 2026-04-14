import { useMemo } from "react";
import { Segmented, Tooltip, Typography } from "antd";
import { LeftOutlined, RightOutlined, InfoCircleOutlined } from "@ant-design/icons";

const { Text } = Typography;

/** Converts "2025-Q1" → "Q1'25" */
const formatPeriodLabel = (key: string): string => {
  const match = key.match(/^(\d{4})-Q([1-4])$/);
  if (!match) return key;
  return `Q${match[2]}'${match[1].slice(2)}`;
};

interface DatasetTimelineControlProps {
  periods: string[];
  selectedPeriod: string;
  onPeriodChange: (period: string) => void;
  cumulativeCount: number;
  addedInQuarter: number;
}

export default function DatasetTimelineControl({
  periods,
  selectedPeriod,
  onPeriodChange,
  cumulativeCount,
  addedInQuarter,
}: DatasetTimelineControlProps) {
  const periodIndex = periods.indexOf(selectedPeriod);
  const isFirstPeriod = periodIndex <= 0;
  const isLastPeriod = periodIndex >= periods.length - 1;
  const periodOptions = useMemo(
    () => periods.map((period) => ({ value: period, label: formatPeriodLabel(period) })),
    [periods],
  );

  const handlePrevPeriod = () => {
    if (!isFirstPeriod) {
      onPeriodChange(periods[periodIndex - 1]);
    }
  };

  const handleNextPeriod = () => {
    if (!isLastPeriod) {
      onPeriodChange(periods[periodIndex + 1]);
    }
  };

  return (
    <div className="max-w-[92vw] rounded-2xl border border-gray-200/60 bg-white/95 px-2 py-2 shadow-xl backdrop-blur-sm pointer-events-auto sm:px-3">
      <div className="flex items-center gap-2 overflow-hidden">
        <Text className="hidden whitespace-nowrap text-xs font-medium text-gray-500 sm:inline">DB as of</Text>

        <button
          onClick={handlePrevPeriod}
          disabled={isFirstPeriod}
          className="flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300"
        >
          <LeftOutlined />
        </button>

        {/* Compact mobile selector: only current step */}
        <div className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 sm:hidden">
          {formatPeriodLabel(selectedPeriod)}
        </div>

        {/* Full selector for tablet/desktop */}
        <div className="hidden overflow-x-auto sm:block">
          <Segmented
            size="small"
            value={selectedPeriod}
            onChange={(value) => onPeriodChange(value as string)}
            options={periodOptions}
          />
        </div>

        <button
          onClick={handleNextPeriod}
          disabled={isLastPeriod}
          className="flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300"
        >
          <RightOutlined />
        </button>

        <Text className="hidden text-xs text-gray-600 md:inline">
          {cumulativeCount.toLocaleString()} total
        </Text>
        <span className="hidden text-gray-300 md:inline">|</span>
        <Text className="hidden text-xs text-gray-600 md:inline">
          {addedInQuarter > 0 ? `+${addedInQuarter.toLocaleString()}` : "+0"}
        </Text>

        <Tooltip
          title={
            <div className="max-w-[200px] text-center text-xs leading-relaxed">
              Cumulative view — shows all datasets uploaded to the database up to the selected quarter.
              Use the arrows or click a period to travel back in time.
            </div>
          }
          placement="top"
        >
          <InfoCircleOutlined className="cursor-help text-gray-400 hover:text-gray-600" style={{ fontSize: 12 }} />
        </Tooltip>
      </div>
    </div>
  );
}
