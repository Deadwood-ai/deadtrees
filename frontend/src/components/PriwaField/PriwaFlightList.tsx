import {
  CloudDownloadOutlined,
  EyeInvisibleOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import { Button, Empty, Tag, Tooltip } from "antd";

import type { IPriwaFlightListItem } from "./priwaFieldFlights";
import { formatPriwaReviewDate } from "./priwaReviewPresentation";

interface PriwaFlightListProps {
  items: IPriwaFlightListItem[];
  hasPrimary: boolean;
  isLoading: boolean;
  onShow: (mosaicId: string) => void;
  onCompare: (mosaicId: string) => void;
  onHide: (mosaicId: string) => void;
}

function FlightRow({
  item,
  hasPrimary,
  onShow,
  onCompare,
  onHide,
}: {
  item: IPriwaFlightListItem;
  hasPrimary: boolean;
  onShow: () => void;
  onCompare: () => void;
  onHide: () => void;
}) {
  const { mosaic, isVisible, isPrimary, isAvailable, offlineEntry } = item;
  const meta = [
    `Aufnahme ${formatPriwaReviewDate(mosaic.captureDate)}`,
    item.matchedTreeCount > 0
      ? `${item.matchedTreeCount} ${item.matchedTreeCount === 1 ? "Baum" : "Bäume"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      data-testid="priwa-flight-row"
      data-visible={isVisible ? "true" : undefined}
      className={`flex items-center gap-1.5 rounded-xl border pl-3 pr-1.5 transition ${
        isVisible
          ? "border-emerald-500 bg-emerald-50"
          : "border-slate-200 bg-white active:bg-slate-50"
      } ${isAvailable ? "" : "opacity-60"}`}
    >
      <button
        type="button"
        className="flex min-h-[56px] min-w-0 flex-1 flex-col justify-center border-0 bg-transparent py-2 text-left"
        aria-label={`${mosaic.label} anzeigen`}
        aria-current={isPrimary ? "true" : undefined}
        disabled={!isAvailable}
        onClick={onShow}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-slate-950">
            {mosaic.label}
          </span>
          {isPrimary && (
            <Tag className="m-0 shrink-0" color="green">
              Angezeigt
            </Tag>
          )}
          {isVisible && !isPrimary && (
            <Tag className="m-0 shrink-0" color="blue">
              Vergleich
            </Tag>
          )}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
          <span className="truncate">{meta}</span>
          {offlineEntry?.available && (
            <span className="inline-flex shrink-0 items-center gap-1 text-emerald-700">
              <CloudDownloadOutlined /> offline
            </span>
          )}
          {!isAvailable && (
            <span className="shrink-0 text-amber-700">nur online</span>
          )}
        </span>
      </button>
      {isVisible ? (
        <Tooltip title="Ausblenden">
          <Button
            type="text"
            size="large"
            icon={<EyeInvisibleOutlined />}
            aria-label={`${mosaic.label} ausblenden`}
            onClick={onHide}
          />
        </Tooltip>
      ) : (
        hasPrimary && (
          <Tooltip title="Mit angezeigter Befliegung vergleichen">
            <Button
              type="text"
              size="large"
              icon={<SwapOutlined />}
              aria-label={`${mosaic.label} zum Vergleich einblenden`}
              disabled={!isAvailable}
              onClick={onCompare}
            />
          </Tooltip>
        )
      )}
    </div>
  );
}

export default function PriwaFlightList({
  items,
  hasPrimary,
  isLoading,
  onShow,
  onCompare,
  onHide,
}: PriwaFlightListProps) {
  if (items.length === 0) {
    return (
      <Empty
        className="py-8"
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          isLoading
            ? "Befliegungen werden geladen…"
            : "Keine Befliegung im Projekt"
        }
      />
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <FlightRow
          key={item.mosaic.id}
          item={item}
          hasPrimary={hasPrimary}
          onShow={() => onShow(item.mosaic.id)}
          onCompare={() => onCompare(item.mosaic.id)}
          onHide={() => onHide(item.mosaic.id)}
        />
      ))}
    </div>
  );
}
