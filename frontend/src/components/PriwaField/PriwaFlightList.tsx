import {
  AimOutlined,
  CloudDownloadOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
} from "@ant-design/icons";
import { Button, Empty, Tooltip } from "antd";

import {
  getPriwaFlightDistance,
  type IPriwaFlightListItem,
} from "./priwaFieldFlights";
import { formatPriwaReviewDate } from "./priwaReviewPresentation";

interface PriwaFlightListProps {
  items: IPriwaFlightListItem[];
  selectedId: string | null;
  mapCenter: number[] | null;
  isLoading: boolean;
  onSelect: (mosaicId: string) => void;
  onShow: (mosaicId: string) => void;
  onHide: (mosaicId: string) => void;
  onFit: (mosaicId: string) => void;
}

export default function PriwaFlightList({
  items,
  selectedId,
  mapCenter,
  isLoading,
  onSelect,
  onShow,
  onHide,
  onFit,
}: PriwaFlightListProps) {
  if (!items.length)
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          isLoading
            ? "Befliegungen werden geladen…"
            : "Keine passenden Befliegungen"
        }
      />
    );
  return (
    <div className="space-y-2">
      {items.map(({ mosaic, isVisible, isAvailable, offlineEntry }) => {
        const distance = getPriwaFlightDistance(mosaic, mapCenter);
        return (
          <div
            key={mosaic.id}
            data-testid="priwa-flight-row"
            data-visible={isVisible}
            className={`rounded-xl border p-2 ${selectedId === mosaic.id ? "border-emerald-600 bg-emerald-50" : "border-slate-200 bg-white"}`}
          >
            <button
              type="button"
              className="block min-h-11 w-full border-0 bg-transparent text-left"
              aria-label={`${mosaic.label} auswählen`}
              aria-current={selectedId === mosaic.id ? "true" : undefined}
              onClick={() => onSelect(mosaic.id)}
            >
              <span className="block break-words text-sm font-semibold text-slate-950">
                {mosaic.label}
              </span>
              <span className="block text-xs text-slate-500">
                {formatPriwaReviewDate(mosaic.captureDate)}
                {Number.isFinite(distance)
                  ? ` · ${(distance / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km von Kartenmitte`
                  : ""}
              </span>
            </button>
            <div className="mt-1 flex items-center gap-1">
              <span className="min-w-0 flex-1 text-xs text-slate-600">
                {isVisible ? "Sichtbar" : "Ausgeblendet"}
                {offlineEntry?.available ? (
                  <span className="ml-2 text-emerald-700">
                    <CloudDownloadOutlined /> offline
                  </span>
                ) : !isAvailable ? (
                  " · nur online"
                ) : (
                  ""
                )}
              </span>
              <Tooltip title="Auf Befliegung zoomen">
                <Button
                  size="large"
                  type="text"
                  icon={<AimOutlined />}
                  aria-label={`Auf ${mosaic.label} zoomen`}
                  disabled={!mosaic.bbox}
                  onClick={() => onFit(mosaic.id)}
                />
              </Tooltip>
              <Tooltip title={isVisible ? "Ausblenden" : "Einblenden"}>
                <Button
                  size="large"
                  type={isVisible ? "primary" : "default"}
                  icon={isVisible ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                  aria-label={`${mosaic.label} ${isVisible ? "ausblenden" : "einblenden"}`}
                  aria-pressed={isVisible}
                  disabled={!isVisible && !isAvailable}
                  onClick={() =>
                    isVisible ? onHide(mosaic.id) : onShow(mosaic.id)
                  }
                />
              </Tooltip>
            </div>
          </div>
        );
      })}
    </div>
  );
}
