import { DeleteOutlined, DownloadOutlined } from "@ant-design/icons";
import { Button, Popover, Typography } from "antd";

import type { IPriwaOfflineBasemapArea } from "./priwaOfflineStore";
import type { usePriwaOfflineBasemap } from "./usePriwaOfflineBasemap";

interface PriwaOfflineMapControlProps {
  areas: IPriwaOfflineBasemapArea[];
  cacheState: ReturnType<typeof usePriwaOfflineBasemap>["cacheState"];
  isSupported: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStartSelection: () => void;
  onClear: () => Promise<void>;
}

export default function PriwaOfflineMapControl({
  areas,
  cacheState,
  isSupported,
  open,
  onOpenChange,
  onStartSelection,
  onClear,
}: PriwaOfflineMapControlProps) {
  const hasAreas = areas.length > 0;
  const totalAreaHa = Math.round(
    areas.reduce((sum, area) => sum + area.areaKm2, 0) * 100,
  );
  const totalCachedTiles = areas.reduce(
    (sum, area) => sum + area.cachedTileCount,
    0,
  );
  const title = hasAreas
    ? "Offline-Karten verwalten"
    : "Offline-Karten speichern";
  const icon = cacheState.isCaching ? (
    <DownloadOutlined spin />
  ) : (
    <DownloadOutlined />
  );

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger="click"
      placement="rightTop"
      content={
        <div className="w-64 space-y-3">
          <div>
            <Typography.Text strong>Offline-Karten</Typography.Text>
            <div className="mt-1 text-xs text-gray-500">
              Wähle einen oder mehrere Bereiche für die Arbeit ohne Empfang.
            </div>
          </div>
          {hasAreas && (
            <div className="rounded-md border border-emerald-100 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-900">
              {areas.length} {areas.length === 1 ? "Bereich" : "Bereiche"} ·{" "}
              {totalAreaHa} ha · {totalCachedTiles.toLocaleString("de-DE")}{" "}
              Kacheln
            </div>
          )}
          <Button
            block
            size="small"
            type={hasAreas ? "default" : "primary"}
            icon={<DownloadOutlined />}
            loading={cacheState.isCaching}
            disabled={!isSupported}
            onClick={() => {
              onOpenChange(false);
              onStartSelection();
            }}
          >
            Neuen Bereich auswählen
          </Button>
          {cacheState.errorMessage && (
            <div className="text-xs text-red-600">
              {cacheState.errorMessage}
            </div>
          )}
          {hasAreas && (
            <Button
              block
              danger
              size="small"
              icon={<DeleteOutlined />}
              disabled={cacheState.isCaching}
              onClick={() => void onClear()}
            >
              Alle Bereiche entfernen
            </Button>
          )}
          {!isSupported && (
            <div className="text-xs text-amber-700">
              Offline-Karten werden von diesem Browser nicht unterstützt.
            </div>
          )}
        </div>
      }
    >
      <Button
        className={
          hasAreas
            ? "pointer-events-auto border-emerald-600 text-emerald-700 shadow-md"
            : "pointer-events-auto shadow-md"
        }
        type={hasAreas ? "primary" : "default"}
        shape="circle"
        size="large"
        icon={icon}
        aria-label={title}
      />
    </Popover>
  );
}
