import {
  CloseOutlined,
  CloudSyncOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { Button, Progress, Typography } from "antd";

import type { IPriwaSyncSummary } from "./priwaOfflineSync";
import type { IPriwaOfflineBasemapArea } from "./priwaOfflineStore";
import type { IPriwaBasemapCacheState } from "./usePriwaOfflineBasemap";

interface PriwaOfflineMapPanelProps {
  areas: IPriwaOfflineBasemapArea[];
  cacheState: IPriwaBasemapCacheState;
  coverageRatio: number;
  isSupported: boolean;
  needsRefresh: boolean;
  readyAreaCount: number;
  syncSummary?: IPriwaSyncSummary;
  onClose: () => void;
  onStartSelection: () => void;
  onClear: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onSyncNow?: () => Promise<void>;
}

const getSyncLabel = (summary?: IPriwaSyncSummary) => {
  if (!summary || summary.total === 0) return null;
  if (summary.failed > 0) return `${summary.failed} Sync-Fehler`;
  if (summary.syncing > 0) return "Erfasste Daten werden synchronisiert";
  return `${summary.pending} erfasste Änderungen ausstehend`;
};

export default function PriwaOfflineMapPanel({
  areas,
  cacheState,
  coverageRatio,
  isSupported,
  needsRefresh,
  readyAreaCount,
  syncSummary,
  onClose,
  onStartSelection,
  onClear,
  onRefresh,
  onSyncNow,
}: PriwaOfflineMapPanelProps) {
  const hasAreas = areas.length > 0;
  const totalAreaHa = Math.round(
    areas.reduce((sum, area) => sum + area.areaKm2, 0) * 100,
  );
  const cachePercent =
    cacheState.total > 0
      ? Math.round(
          ((cacheState.cached + cacheState.failed) / cacheState.total) * 100,
        )
      : 0;
  const syncLabel = getSyncLabel(syncSummary);

  return (
    <section
      className="pointer-events-auto absolute bottom-4 left-4 right-4 z-[70] max-h-[55dvh] overflow-y-auto rounded-md bg-white/95 p-3 shadow-lg backdrop-blur min-[992px]:bottom-5 min-[992px]:left-1/2 min-[992px]:max-w-lg min-[992px]:-translate-x-1/2"
      aria-label="Offline-Karten"
      data-priwa-offline-map-panel="true"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <Typography.Text strong>Offline-Karten</Typography.Text>
          <div className="mt-1 text-xs text-gray-600">
            {Math.round(coverageRatio * 100)} % der aktuellen Kartenansicht sind
            offline verfügbar.
          </div>
        </div>
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined />}
          aria-label="Offline-Karten schließen"
          onClick={onClose}
        />
      </div>

      {hasAreas && (
        <div className="mt-3 rounded-md border border-emerald-100 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-900">
          {readyAreaCount} von {areas.length} Bereichen bereit · {totalAreaHa}{" "}
          ha
        </div>
      )}
      {needsRefresh && (
        <div className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          Vorhandene Offline-Karten müssen einmal aktualisiert werden, damit sie
          auf dem iPhone ohne Netz funktionieren.
        </div>
      )}
      {cacheState.isCaching && (
        <Progress
          className="mt-2"
          percent={cachePercent}
          size="small"
          status={cacheState.failed > 0 ? "exception" : "active"}
        />
      )}
      {cacheState.errorMessage && (
        <div className="mt-2 text-xs text-red-600">
          {cacheState.errorMessage}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2">
        {needsRefresh && (
          <Button
            block
            icon={<ReloadOutlined />}
            loading={cacheState.isCaching}
            disabled={!isSupported}
            onClick={() => void onRefresh()}
          >
            Offline-Karten aktualisieren
          </Button>
        )}
        <Button
          block
          type={hasAreas ? "default" : "primary"}
          icon={<DownloadOutlined />}
          loading={cacheState.isCaching}
          disabled={!isSupported}
          onClick={onStartSelection}
        >
          Neuen Bereich auswählen
        </Button>
        {hasAreas && (
          <Button
            block
            danger
            icon={<DeleteOutlined />}
            disabled={cacheState.isCaching}
            onClick={() => void onClear()}
          >
            Alle Bereiche entfernen
          </Button>
        )}
      </div>

      {syncLabel && (
        <div className="mt-3 border-t border-gray-200 pt-3">
          <div className="text-xs text-gray-600">{syncLabel}</div>
          <Button
            className="mt-2"
            block
            size="small"
            icon={<CloudSyncOutlined spin={!!syncSummary?.syncing} />}
            disabled={!onSyncNow}
            onClick={() => void onSyncNow?.()}
          >
            Jetzt synchronisieren
          </Button>
        </div>
      )}

      {!isSupported && (
        <div className="mt-2 text-xs text-amber-700">
          Offline-Karten werden von diesem Browser nicht unterstützt.
        </div>
      )}
    </section>
  );
}
