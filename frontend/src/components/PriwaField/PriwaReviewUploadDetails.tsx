import { ExclamationCircleFilled, PlusOutlined } from "@ant-design/icons";
import { Button, Tag } from "antd";

import {
  formatPriwaReviewDate,
  priwaReviewStatusPresentation,
} from "./priwaReviewPresentation";
import type { IPriwaReviewItem } from "./priwaReviewWorkspace";
import type { IPriwaMosaic, PriwaFlightType } from "./usePriwaMosaics";

interface PriwaReviewUploadDetailsProps {
  item: Extract<IPriwaReviewItem, { kind: "unassigned-upload" }>;
  isClassifyingFlight: boolean;
  onSetFlightType: (
    datasetId: string,
    flightType: PriwaFlightType,
  ) => Promise<void>;
  onCreateGroupForFlight: (mosaic: IPriwaMosaic) => void;
}

export default function PriwaReviewUploadDetails({
  item,
  isClassifyingFlight,
  onSetFlightType,
  onCreateGroupForFlight,
}: PriwaReviewUploadDetailsProps) {
  const isExcluded = item.status === "excluded_upload";
  const presentation = priwaReviewStatusPresentation[item.status];
  return (
    <div className="space-y-5">
      <div>
        <Tag color={presentation.color}>{presentation.label}</Tag>
        <h2 className="mt-2 text-lg font-semibold text-slate-950">
          {item.mosaic.label}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Aufnahme {formatPriwaReviewDate(item.mosaic.captureDate)} · Upload{" "}
          {formatPriwaReviewDate(item.mosaic.createdAt)}
        </p>
      </div>
      <div className="rounded-md bg-amber-50 px-3 py-3 text-sm text-amber-900">
        <div className="flex items-start gap-2">
          <ExclamationCircleFilled className="mt-0.5" />
          <span>{item.reason}</span>
        </div>
      </div>
      <div className="space-y-2">
        {isExcluded ? (
          <Button
            block
            loading={isClassifyingFlight}
            onClick={() => void onSetFlightType(item.mosaic.id, null)}
          >
            Zur Prüfung zurücksetzen
          </Button>
        ) : (
          <>
            <Button
              block
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => onCreateGroupForFlight(item.mosaic)}
            >
              Befallsgruppe anlegen
            </Button>
            <Button
              block
              danger
              loading={isClassifyingFlight}
              onClick={() => void onSetFlightType(item.mosaic.id, "not_priwa")}
            >
              Nicht PRIWA-relevant
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
