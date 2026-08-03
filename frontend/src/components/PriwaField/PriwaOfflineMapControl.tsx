import { DeleteOutlined, DownloadOutlined } from "@ant-design/icons";
import { Button, Popover, Progress, Typography } from "antd";

import type { IPriwaOfflineBasemapArea } from "./priwaOfflineStore";
import type { usePriwaOfflineBasemap } from "./usePriwaOfflineBasemap";

interface PriwaOfflineMapControlProps {
  area: IPriwaOfflineBasemapArea | null;
  cacheState: ReturnType<typeof usePriwaOfflineBasemap>["cacheState"];
  isSupported: boolean;
  onCache: () => Promise<void>;
  onClear: () => Promise<void>;
}

export default function PriwaOfflineMapControl({
  area,
  cacheState,
  isSupported,
  onCache,
  onClear,
}: PriwaOfflineMapControlProps) {
  const cachePercent =
    cacheState.total > 0
      ? Math.round(
          ((cacheState.cached + cacheState.failed) / cacheState.total) * 100,
        )
      : 0;
  const title = area ? "Offline-Karten verwalten" : "Offline-Karten speichern";
  const icon = cacheState.isCaching ? (
    <DownloadOutlined spin />
  ) : (
    <DownloadOutlined />
  );

  return (
    <Popover
      trigger="click"
      placement="rightTop"
      content={
        <div className="w-64 space-y-3">
          <div>
            <Typography.Text strong>Offline-Karten</Typography.Text>
            <div className="mt-1 text-xs text-gray-500">
              Speichert den aktuellen Ausschnitt für die Arbeit im Wald.
            </div>
          </div>
          {area && (
            <div className="rounded-md border border-emerald-100 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-900">
              {area.cachedTileCount} Kacheln · {area.areaKm2.toFixed(2)} km²
            </div>
          )}
          <Button
            block
            size="small"
            type={area ? "default" : "primary"}
            icon={<DownloadOutlined />}
            loading={cacheState.isCaching}
            disabled={!isSupported}
            onClick={() => void onCache()}
          >
            Ausschnitt + Umgebung speichern
          </Button>
          {cacheState.isCaching && (
            <Progress
              percent={cachePercent}
              size="small"
              status={cacheState.failed > 0 ? "exception" : "active"}
            />
          )}
          {cacheState.errorMessage && (
            <div className="text-xs text-red-600">
              {cacheState.errorMessage}
            </div>
          )}
          {area && (
            <Button
              block
              danger
              size="small"
              icon={<DeleteOutlined />}
              disabled={cacheState.isCaching}
              onClick={() => void onClear()}
            >
              Bereich entfernen
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
          area
            ? "pointer-events-auto border-emerald-600 text-emerald-700 shadow-md"
            : "pointer-events-auto shadow-md"
        }
        type={area ? "primary" : "default"}
        shape="circle"
        size="large"
        icon={icon}
        aria-label={title}
      />
    </Popover>
  );
}
