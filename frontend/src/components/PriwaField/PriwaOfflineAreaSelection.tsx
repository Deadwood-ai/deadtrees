import { Button, Progress } from "antd";

import {
  PRIWA_BASEMAP_MAX_AREA_KM2,
  PRIWA_BASEMAP_MAX_TILES,
  PRIWA_BASEMAP_SELECTION_INSET_RATIO,
} from "./priwaOfflineBasemap";
import type { IPriwaBasemapCacheState } from "./usePriwaOfflineBasemap";
import type { IPriwaOfflineSelectionPlan } from "./usePriwaOfflineSelectionPlan";

interface PriwaOfflineAreaSelectionProps {
  plan: IPriwaOfflineSelectionPlan | null;
  cacheState: IPriwaBasemapCacheState;
  onCancel: () => void;
  onConfirm: (plan: IPriwaOfflineSelectionPlan) => Promise<void>;
}

const selectionInset = `${PRIWA_BASEMAP_SELECTION_INSET_RATIO * 100}%`;

export default function PriwaOfflineAreaSelection({
  plan,
  cacheState,
  onCancel,
  onConfirm,
}: PriwaOfflineAreaSelectionProps) {
  const isValid =
    !!plan &&
    plan.areaKm2 <= PRIWA_BASEMAP_MAX_AREA_KM2 &&
    plan.tileCount > 0 &&
    plan.tileCount <= PRIWA_BASEMAP_MAX_TILES;
  const cachePercent =
    cacheState.total > 0
      ? Math.round(
          ((cacheState.cached + cacheState.failed) / cacheState.total) * 100,
        )
      : 0;

  return (
    <div className="pointer-events-none absolute inset-0 z-[70]">
      <div
        className="absolute inset-x-0 top-0 bg-slate-950/45"
        style={{ height: selectionInset }}
      />
      <div
        className="absolute inset-x-0 bottom-0 bg-slate-950/45"
        style={{ height: selectionInset }}
      />
      <div
        className="absolute left-0 bg-slate-950/45"
        style={{
          bottom: selectionInset,
          top: selectionInset,
          width: selectionInset,
        }}
      />
      <div
        className="absolute right-0 bg-slate-950/45"
        style={{
          bottom: selectionInset,
          top: selectionInset,
          width: selectionInset,
        }}
      />
      <div
        className="absolute rounded-md border-2 border-white shadow-[0_0_0_1px_rgba(5,150,105,0.95)]"
        data-priwa-offline-selection-frame="true"
        style={{ inset: selectionInset }}
      />

      <div className="pointer-events-auto absolute bottom-4 left-4 right-4 rounded-md bg-white/95 p-3 shadow-lg backdrop-blur md:bottom-5 md:left-1/2 md:max-w-lg md:-translate-x-1/2">
        <div className="text-sm font-medium text-gray-900">
          Karte verschieben oder zoomen
        </div>
        <div className="mt-0.5 text-xs text-gray-600">
          Der klare Rahmen wird für Luftbild und topografische Karte
          gespeichert.
        </div>
        {plan && (
          <div
            className={
              isValid
                ? "mt-2 text-xs text-emerald-800"
                : "mt-2 text-xs text-red-600"
            }
          >
            {Math.round(plan.areaKm2 * 100)} ha ·{" "}
            {plan.tileCount.toLocaleString("de-DE")} Kacheln
            {!isValid && " · Bereich bitte verkleinern"}
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
        <div className="mt-3 flex gap-2">
          <Button block disabled={cacheState.isCaching} onClick={onCancel}>
            Abbrechen
          </Button>
          <Button
            block
            type="primary"
            loading={cacheState.isCaching}
            disabled={!isValid}
            onClick={() => {
              if (plan) void onConfirm(plan);
            }}
          >
            Bereich herunterladen
          </Button>
        </div>
      </div>
    </div>
  );
}
