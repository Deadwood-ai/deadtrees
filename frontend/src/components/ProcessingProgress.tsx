import React from "react";
import { Tooltip, Tag } from "antd";
import { SyncOutlined, CloseCircleOutlined, ScheduleOutlined } from "@ant-design/icons";
import { calculateProcessingProgress, DatasetProgress } from "../utils/processingSteps";
import { QueueInfo } from "../hooks/useQueuePositions";
import AuditBadge from "./AuditBadge";

interface ProcessingProgressProps {
  dataset: DatasetProgress;
  showDetails?: boolean;
  queueInfo?: QueueInfo;
}

const ProcessingProgress: React.FC<ProcessingProgressProps> = ({ dataset, showDetails = true, queueInfo }) => {
  const progress = calculateProcessingProgress(dataset);
  const normalizedAssessment = dataset.final_assessment === "ready" ? "no_issues" : dataset.final_assessment;
  const audit = normalizedAssessment
    ? {
      final_assessment: normalizedAssessment,
      audit_date: dataset.audit_date ?? null,
      deadwood_quality: dataset.deadwood_quality ?? null,
      forest_cover_quality: dataset.forest_cover_quality ?? null,
      has_valid_phenology: dataset.has_valid_phenology ?? null,
      has_valid_acquisition_date: dataset.has_valid_acquisition_date ?? null,
    }
    : null;

  // Handle error state
  if (dataset.has_error) {
    return (
      <Tooltip title="An error occurred during processing">
        <Tag icon={<CloseCircleOutlined />} color="error">
          Error
        </Tag>
      </Tooltip>
    );
  }

  // Handle pending state (uploaded, not started yet → queued)
  const hasStartedAnyStep = Boolean(
    dataset.is_odm_done ||
    dataset.is_ortho_done ||
    dataset.is_metadata_done ||
    dataset.is_cog_done ||
    dataset.is_deadwood_done ||
    dataset.is_forest_cover_done,
  );

  const isQueued = Boolean(
    dataset.is_upload_done &&
    !hasStartedAnyStep &&
    !dataset.has_error &&
    (dataset.current_status === "idle" || dataset.current_status === undefined || dataset.current_status === null),
  );

  if (isQueued) {
    const positionText =
      queueInfo && typeof queueInfo.current_position === "number"
        ? `In queue: #${queueInfo.current_position}`
        : "Pending in queue";

    const tooltipText = queueInfo?.estimated_time
      ? `Estimated start in ~${Math.round(queueInfo.estimated_time)} min`
      : "Waiting for processing to start";

    return (
      <Tooltip title={tooltipText}>
        <Tag color="blue">{positionText}</Tag>
      </Tooltip>
    );
  }

  // Handle complete state
  if (progress.isComplete) {
    if (audit?.final_assessment) {
      return <AuditBadge datasetId={(dataset as DatasetProgress & { id: number }).id} audit={audit} />;
    }
    return (
      <Tooltip title="Processing complete - awaiting audit">
        <Tag icon={<ScheduleOutlined />} color="blue">
          Awaiting audit
        </Tag>
      </Tooltip>
    );
  }

  // Handle processing state - compact single row version
  const progressElement = (
    <div className="flex items-center gap-2">
      <span className="whitespace-nowrap text-sm font-medium">
        Step {progress.currentStep} of {progress.totalSteps}
      </span>
      <div className="h-1 w-16 overflow-hidden rounded-full bg-gray-200">
        <div
          className="h-full rounded-full bg-blue-500 transition-all duration-300"
          style={{ width: `${progress.percentage}%` }}
        />
      </div>
      <SyncOutlined spin />
    </div>
  );

  if (showDetails) {
    return (
      <Tooltip
        title={
          <div>
            <div className="font-medium">{progress.currentStepInfo.label}</div>
            <div className="text-xs opacity-90">{progress.currentStepInfo.description}</div>
          </div>
        }
      >
        {progressElement}
      </Tooltip>
    );
  }

  return progressElement;
};

export default ProcessingProgress;
