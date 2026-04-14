import { Spin, Tooltip } from "antd";
import { CheckCircleOutlined, SyncOutlined, ClockCircleOutlined } from "@ant-design/icons";
import { useProcessingStats, isSentinelConfigured } from "../../hooks/useProcessingStats";

const ProcessingStatsBanner = () => {
  const { data: stats, isLoading, isFetching } = useProcessingStats();

  // Don't render if sentinel processing is not configured
  if (!isSentinelConfigured) {
    return null;
  }

  if (isLoading || isFetching) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-white/95 px-3 py-1.5 backdrop-blur-sm">
        <Spin size="small" />
        <span className="text-xs text-gray-500">Loading stats...</span>
      </div>
    );
  }

  if (!stats) {
    return null; // Silently fail - don't show anything if stats unavailable
  }

  const isActive = stats.inProgress > 0;

  return (
    <Tooltip
      title={
        <div className="text-xs">
          <div className="mb-1 font-medium">EU Processing Status</div>
          <div>Total tiles: {stats.totalTiles.toLocaleString()}</div>
          <div>Pending: {stats.pending.toLocaleString()}</div>
          {stats.errors > 0 && <div className="text-red-300">Errors: {stats.errors}</div>}
        </div>
      }
    >
      <div className="flex items-center gap-3 rounded-lg bg-white/95 px-3 py-1.5 backdrop-blur-sm">
        {/* EU Label */}
        <div className="flex items-center gap-1">
          <span className="text-sm">🇪🇺</span>
          <span className="text-xs font-medium text-gray-700">EU</span>
        </div>

        <div className="h-4 w-px bg-gray-200" />

        {/* Status Indicator */}
        <div className="flex items-center gap-1.5">
          {isActive ? (
            <SyncOutlined spin className="text-green-500" />
          ) : (
            <ClockCircleOutlined className="text-gray-400" />
          )}
          <span className={`text-xs font-medium ${isActive ? "text-green-600" : "text-gray-500"}`}>
            {isActive ? "Processing" : "Idle"}
          </span>
        </div>

        <div className="h-4 w-px bg-gray-200" />

        {/* Completed */}
        <div className="flex items-center gap-1.5">
          <CheckCircleOutlined className="text-blue-500" />
          <span className="text-xs text-gray-600">
            <span className="font-semibold text-gray-800">{stats.completed.toLocaleString()}</span> Done
          </span>
        </div>

        <div className="h-4 w-px bg-gray-200" />

        {/* In Progress */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-600">
            <span className="font-semibold text-gray-800">{stats.inProgress}</span> In Progress
          </span>
        </div>

        <div className="h-4 w-px bg-gray-200" />

        {/* Percentage */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-blue-600">{stats.percentComplete}%</span>
          <span className="text-xs text-gray-500">Complete</span>
        </div>
      </div>
    </Tooltip>
  );
};

export default ProcessingStatsBanner;
