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

const formatDistanceKm = (meters: number) =>
  `${(meters / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km`;

/**
 * One compact row per flight. The whole row surface selects the flight for the
 * pinned details; the zoom and visibility buttons on the right stay independent.
 */
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
    <div className="space-y-1">
      {items.map(({ mosaic, isVisible, isAvailable, offlineEntry }) => {
        const isSelected = selectedId === mosaic.id;
        const distance = getPriwaFlightDistance(mosaic, mapCenter);
        return (
          <div
            key={mosaic.id}
            data-testid="priwa-flight-row"
            data-visible={isVisible}
            data-selected={isSelected}
            className={`relative flex min-h-[3.25rem] items-center gap-1 rounded-lg border py-1 pl-3 pr-1 transition-colors ${
              isSelected
                ? "border-emerald-600 bg-emerald-50 shadow-[inset_3px_0_0_0_theme(colors.emerald.600)]"
                : "border-slate-200 bg-white"
            }`}
          >
            {/* Hit surface underneath the text; the action buttons sit above it. */}
            <button
              type="button"
              className={`absolute inset-0 z-0 cursor-pointer rounded-lg border-0 bg-transparent p-0 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 ${
                isSelected ? "active:bg-emerald-100" : "active:bg-slate-100"
              }`}
              aria-label={`${mosaic.label} auswählen`}
              aria-current={isSelected ? "true" : undefined}
              onClick={() => onSelect(mosaic.id)}
            />
            <div className="pointer-events-none relative min-w-0 flex-1">
              <span
                className={`block truncate text-sm ${isSelected ? "font-semibold text-emerald-950" : "font-medium text-slate-950"}`}
                title={mosaic.label}
              >
                {mosaic.label}
              </span>
              <span className="block truncate text-xs text-slate-500">
                {formatPriwaReviewDate(mosaic.captureDate)}
                {Number.isFinite(distance) && ` · ${formatDistanceKm(distance)}`}
                {offlineEntry?.available ? (
                  <span className="ml-1 text-emerald-700">
                    <CloudDownloadOutlined /> offline
                  </span>
                ) : !isAvailable ? (
                  " · nur online"
                ) : null}
              </span>
            </div>
            <div className="relative flex shrink-0 items-center gap-0.5">
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
                  type={isVisible ? "primary" : "text"}
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
