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
  /**
   * Download slot: a `display: contents` wrapper whose first child is the
   * action button (third grid column) followed by `col-span-full` status lines.
   */
  children?: ReactNode;
  onShow: (mosaicId: string) => void;
  onFit: (mosaicId: string) => void;
  onHide: (mosaicId: string) => void;
}

/**
 * Pinned card for the selected flight: one action row (zoom, visibility,
 * download) beside the name, status lines below, metadata on demand.
 */
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
      aria-label="Ausgewählte Befliegung"
      className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-0.5 gap-y-1 rounded-lg border border-emerald-300 bg-emerald-50 py-1.5 pl-3 pr-1"
    >
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase leading-4 tracking-wide text-emerald-700">
          Ausgewählte Befliegung
        </div>
        <h3
          className="m-0 truncate text-sm font-semibold leading-5 text-emerald-950"
          title={mosaic.label}
        >
          {mosaic.label}
        </h3>
        <div className="truncate text-xs leading-4 text-slate-600">
          {formatPriwaReviewDate(mosaic.captureDate)}
          {primary.isVisible ? " · Sichtbar" : ""}
          {primary.offlineEntry?.available ? " · Offline gespeichert" : ""}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip title="Auf Befliegung zoomen">
          <Button
            size="large"
            type="text"
            icon={<AimOutlined />}
            aria-label="Auf Befliegung zoomen"
            disabled={!mosaic.bbox}
            onClick={() => onFit(mosaic.id)}
          />
        </Tooltip>
        <Tooltip title={primary.isVisible ? "Ausblenden" : "Einblenden"}>
          <Button
            size="large"
            type={primary.isVisible ? "primary" : "text"}
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
      {children}
      <details className="col-span-full text-xs text-slate-600">
        <summary className="cursor-pointer select-none py-0.5 text-slate-500">
          Details
        </summary>
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
