import {
  AimOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
} from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import type { ReactNode } from "react";

import {
  formatPriwaFlightAuthors,
  type IPriwaFlightListItem,
} from "./priwaFieldFlights";
import { formatPriwaReviewDate } from "./priwaReviewPresentation";

interface PriwaFlightDetailsProps {
  primary: IPriwaFlightListItem;
  children?: ReactNode;
  onShow: (mosaicId: string) => void;
  onFit: (mosaicId: string) => void;
  onHide: (mosaicId: string) => void;
}

/** Compact selected flight with secondary metadata available on demand. */
export default function PriwaFlightDetails({
  primary,
  children,
  onShow,
  onFit,
  onHide,
}: PriwaFlightDetailsProps) {
  const { mosaic } = primary;
  const authors = formatPriwaFlightAuthors(mosaic.authors);
  return (
    <section
      data-testid="priwa-flight-details"
      className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-2.5"
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-800">
            Ausgewählte Befliegung
          </div>
          <h3
            className="my-0.5 line-clamp-2 break-words text-sm font-semibold text-slate-950"
            title={mosaic.label}
          >
            {mosaic.label}
          </h3>
          <div className="text-xs text-slate-600">
            {formatPriwaReviewDate(mosaic.captureDate)} ·{" "}
            {primary.offlineEntry?.available ? "Offline gespeichert" : "Online"}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Tooltip title="Auf Befliegung zoomen">
            <Button
              size="large"
              shape="circle"
              icon={<AimOutlined />}
              aria-label="Auf Befliegung zoomen"
              disabled={!mosaic.bbox}
              onClick={() => onFit(mosaic.id)}
            />
          </Tooltip>
          <Tooltip title={primary.isVisible ? "Ausblenden" : "Einblenden"}>
            <Button
              size="large"
              shape="circle"
              icon={
                primary.isVisible ? <EyeInvisibleOutlined /> : <EyeOutlined />
              }
              aria-label={`${mosaic.label} ${primary.isVisible ? "ausblenden" : "einblenden"}`}
              aria-pressed={primary.isVisible}
              disabled={!primary.isVisible && !primary.isAvailable}
              onClick={() =>
                primary.isVisible ? onHide(mosaic.id) : onShow(mosaic.id)
              }
            />
          </Tooltip>
        </div>
      </div>
      {children}
      <details className="mt-1 text-xs text-slate-600">
        <summary className="cursor-pointer py-1">Details</summary>
        <div className="break-words pt-1">{mosaic.label}</div>
        <dl className="mb-0 mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt>Upload</dt>
          <dd className="m-0">{formatPriwaReviewDate(mosaic.createdAt)}</dd>
          {authors && (
            <>
              <dt>Von</dt>
              <dd className="m-0 break-words">{authors}</dd>
            </>
          )}
          {primary.matchedTreeCount > 0 && (
            <>
              <dt>Käferbäume</dt>
              <dd className="m-0">{primary.matchedTreeCount} im Umfeld</dd>
            </>
          )}
        </dl>
      </details>
    </section>
  );
}
