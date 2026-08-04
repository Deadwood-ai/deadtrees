import { EyeInvisibleOutlined, EyeOutlined } from "@ant-design/icons";
import { Button, Checkbox, Tooltip } from "antd";
import type { ReactNode } from "react";

import { formatPriwaReviewDate } from "./priwaReviewPresentation";
import type { IPriwaMosaic } from "./usePriwaMosaics";

interface PriwaReviewFlightCardProps {
  mosaic: IPriwaMosaic;
  tone: "assigned" | "suggested";
  isVisible: boolean;
  isAssigned: boolean;
  isSaving: boolean;
  assignmentLabel: string;
  assignmentAriaLabel: string;
  onVisibilityChange: (isVisible: boolean) => void;
  onAssignmentChange: (isAssigned: boolean) => void;
  children?: ReactNode;
}

export default function PriwaReviewFlightCard({
  mosaic,
  tone,
  isVisible,
  isAssigned,
  isSaving,
  assignmentLabel,
  assignmentAriaLabel,
  onVisibilityChange,
  onAssignmentChange,
  children,
}: PriwaReviewFlightCardProps) {
  const isSuggested = tone === "suggested";

  return (
    <div
      className={`rounded-md border px-3 py-2.5 ${
        isSuggested
          ? "border-blue-200 bg-blue-50"
          : "border-slate-200 bg-slate-50"
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div
            className={`truncate text-sm font-medium ${
              isSuggested ? "text-blue-950" : "text-slate-950"
            }`}
            title={mosaic.label}
          >
            {mosaic.label}
          </div>
          <div
            className={`mt-0.5 text-xs ${
              isSuggested ? "text-blue-800" : "text-slate-500"
            }`}
          >
            {isSuggested && "Vorschlag · "}Aufnahme{" "}
            {formatPriwaReviewDate(mosaic.captureDate)}
          </div>
        </div>
        <Tooltip
          title={isVisible ? "Befliegung ausblenden" : "Befliegung einblenden"}
        >
          <Button
            size="small"
            type={isVisible ? "primary" : "default"}
            icon={isVisible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
            aria-label={
              isVisible ? "Befliegung ausblenden" : "Befliegung einblenden"
            }
            aria-pressed={isVisible}
            onClick={() => onVisibilityChange(!isVisible)}
          />
        </Tooltip>
      </div>
      <Checkbox
        className="mt-2 text-xs"
        checked={isAssigned}
        disabled={isSaving}
        aria-label={assignmentAriaLabel}
        onChange={(event) => onAssignmentChange(event.target.checked)}
      >
        {assignmentLabel}
      </Checkbox>
      {children}
    </div>
  );
}
