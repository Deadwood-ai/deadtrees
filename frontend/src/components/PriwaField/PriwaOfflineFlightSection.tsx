import {
  AimOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { Alert, Button, Progress } from "antd";
import { useRef } from "react";

import MobileMapSectionHeading from "../MapControls/mobile/MobileMapSectionHeading";
import { formatPriwaAreaKm2, formatPriwaMebibytes } from "./priwaFieldFlights";
import {
  PRIWA_OFFLINE_MOSAIC_AREA_KM2,
  PRIWA_OFFLINE_MOSAIC_BYTES,
  PRIWA_OFFLINE_MOSAIC_LIMIT,
} from "./priwaOfflineMosaicPlan";
import { formatPriwaReviewDate } from "./priwaReviewPresentation";
import type { IPriwaMosaic } from "./usePriwaMosaics";
import type { PriwaOfflineMosaicsState } from "./usePriwaOfflineMosaics";

interface PriwaOfflineFlightSectionProps {
  offline: PriwaOfflineMosaicsState;
  /** The selected flight, independent of map visibility. */
  selectedFlights: IPriwaMosaic[];
  isOnline: boolean;
  onZoomToFlight: (mosaicId: string) => void;
}

const sumBy = <T,>(items: T[], pick: (item: T) => number) =>
  items.reduce((sum, item) => sum + pick(item), 0);

/**
 * Stores complete orthomosaics (the original COG, full footprint, native
 * resolution) on the device. Deliberately separate from the basemap tile cache.
 */
export default function PriwaOfflineFlightSection({
  offline,
  selectedFlights,
  isOnline,
  onZoomToFlight,
}: PriwaOfflineFlightSectionProps) {
  const lastSelectionRef = useRef<IPriwaMosaic[]>([]);
  const { entries, plans, progress, error, busy, persistent, supported } =
    offline;
  const savedIds = new Set(
    entries.filter((entry) => entry.available).map((entry) => entry.mosaic.id),
  );
  const selectable = selectedFlights.filter(
    (flight) => !savedIds.has(flight.id),
  );
  const wouldExceedCount =
    entries.length + selectable.length > PRIWA_OFFLINE_MOSAIC_LIMIT;
  const planBytes = sumBy(plans, (plan) => plan.bytes);
  const planArea = sumBy(plans, (plan) => plan.areaKm2);
  const savedBytes = sumBy(entries, (entry) => entry.bytes);
  const savedArea = sumBy(entries, (entry) => entry.areaKm2);
  const isDownloading = !!progress;

  const prepare = () => {
    lastSelectionRef.current = selectable;
    void offline.plan(selectable);
  };
  const retry = () => {
    if (plans.length > 0) void offline.download();
    else if (lastSelectionRef.current.length > 0) {
      void offline.plan(lastSelectionRef.current);
    }
  };

  return (
    <section data-testid="priwa-offline-flights" className="space-y-2">
      <MobileMapSectionHeading>Offline-Befliegungen</MobileMapSectionHeading>
      <p className="-mt-1 text-xs text-slate-500">
        Komplette Befliegungen, volle Auflösung. Max.{" "}
        {PRIWA_OFFLINE_MOSAIC_LIMIT}
        {" · "}
        {formatPriwaMebibytes(PRIWA_OFFLINE_MOSAIC_BYTES)}
        {" · "}
        {formatPriwaAreaKm2(PRIWA_OFFLINE_MOSAIC_AREA_KM2)}.
      </p>

      {!supported && (
        <Alert
          type="warning"
          showIcon
          message="Dieser Browser unterstützt keine Offline-Befliegungen."
        />
      )}

      {entries.length > 0 && (
        <div className="space-y-1.5">
          {entries.map((entry) => (
            <div
              key={entry.mosaic.id}
              data-testid="priwa-offline-flight-entry"
              className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white pl-3 pr-1.5 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <CloudDownloadOutlined
                    className={
                      entry.available ? "text-emerald-600" : "text-amber-500"
                    }
                  />
                  <span className="truncate text-sm font-medium text-slate-950">
                    {entry.mosaic.label}
                  </span>
                </div>
                <div className="text-xs text-slate-500">
                  {entry.available
                    ? `Gespeichert ${formatPriwaReviewDate(entry.savedAt)} · ${formatPriwaMebibytes(entry.bytes)} · ${formatPriwaAreaKm2(entry.areaKm2)}`
                    : "Unvollständig – bitte erneut herunterladen"}
                </div>
              </div>
              {entry.available && (
                <Button
                  type="text"
                  size="large"
                  icon={<AimOutlined />}
                  aria-label={`Zur gespeicherten Befliegung ${entry.mosaic.label} zoomen`}
                  onClick={() => onZoomToFlight(entry.mosaic.id)}
                />
              )}
              <Button
                type="text"
                size="large"
                danger
                icon={<DeleteOutlined />}
                aria-label={`Offline-Befliegung ${entry.mosaic.label} entfernen`}
                disabled={busy}
                onClick={() => void offline.remove(entry.mosaic.id)}
              />
            </div>
          ))}
          <div className="text-xs text-slate-500">
            {entries.length} von {PRIWA_OFFLINE_MOSAIC_LIMIT} gespeichert ·{" "}
            {formatPriwaMebibytes(savedBytes)} von{" "}
            {formatPriwaMebibytes(PRIWA_OFFLINE_MOSAIC_BYTES)} ·{" "}
            {formatPriwaAreaKm2(savedArea)} von{" "}
            {formatPriwaAreaKm2(PRIWA_OFFLINE_MOSAIC_AREA_KM2)}
          </div>
          {persistent === false && (
            <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <WarningOutlined className="mt-0.5 shrink-0" />
              <span>
                Der Browser darf gespeicherte Befliegungen bei Speichermangel
                wieder löschen. Vor dem Einsatz ohne Netz kurz prüfen.
              </span>
            </div>
          )}
        </div>
      )}

      {isDownloading && progress && (
        <div
          data-testid="priwa-offline-flight-progress"
          className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2"
        >
          <div className="truncate text-xs font-medium text-slate-800">
            {progress.label} wird gespeichert
          </div>
          <Progress
            percent={
              progress.totalBytes > 0
                ? Math.round(
                    (progress.downloadedBytes / progress.totalBytes) * 100,
                  )
                : 0
            }
            size="small"
            status="active"
          />
          <div className="flex items-center justify-between gap-2 text-xs text-slate-600">
            <span>
              {formatPriwaMebibytes(progress.downloadedBytes)} von{" "}
              {formatPriwaMebibytes(progress.totalBytes)}
            </span>
            <Button size="small" onClick={offline.cancel}>
              Abbrechen
            </Button>
          </div>
        </div>
      )}

      {error && !isDownloading && (
        <Alert
          type="error"
          showIcon
          message={error}
          action={
            (plans.length > 0 || lastSelectionRef.current.length > 0) && (
              <Button size="small" disabled={!isOnline || busy} onClick={retry}>
                Erneut versuchen
              </Button>
            )
          }
        />
      )}

      {plans.length > 0 && !isDownloading && (
        <div
          data-testid="priwa-offline-flight-plan"
          className="rounded-xl border border-emerald-300 bg-white px-3 py-2.5"
        >
          <div className="text-sm font-semibold text-slate-950">
            Bereit zum Speichern: {formatPriwaMebibytes(planBytes)} ·{" "}
            {formatPriwaAreaKm2(planArea)}
          </div>
          <ul className="my-1 list-none p-0 text-xs text-slate-600">
            {plans.map((plan) => (
              <li key={plan.mosaic.id} className="truncate">
                {plan.mosaic.label} · {formatPriwaMebibytes(plan.bytes)} ·{" "}
                {formatPriwaAreaKm2(plan.areaKm2)}
              </li>
            ))}
          </ul>
          <div className="text-xs text-slate-500">
            Vollständige Flugfläche in voller Auflösung, kein Zuschnitt.
          </div>
          <div className="mt-2 space-y-1">
            <Button
              block
              type="primary"
              size="large"
              icon={<CloudDownloadOutlined />}
              loading={busy}
              disabled={!isOnline}
              onClick={() => void offline.download()}
            >
              Jetzt herunterladen
            </Button>
            <Button
              block
              type="text"
              disabled={busy}
              onClick={offline.clearPlan}
            >
              Verwerfen
            </Button>
          </div>
        </div>
      )}

      {plans.length === 0 && !isDownloading && supported && (
        <>
          {selectedFlights.length === 0 ? (
            <p className="text-xs text-slate-500">
              Zum Speichern eine Befliegung auswählen.
            </p>
          ) : selectable.length === 0 ? (
            <p className="text-xs text-emerald-700">
              Bereits offline gespeichert.
            </p>
          ) : wouldExceedCount ? (
            <p className="text-xs text-amber-700">
              Bitte zuerst eine gespeicherte Befliegung entfernen (höchstens{" "}
              {PRIWA_OFFLINE_MOSAIC_LIMIT}).
            </p>
          ) : (
            <>
              <Button
                block
                size="large"
                icon={<CloudDownloadOutlined />}
                loading={busy}
                disabled={!isOnline}
                onClick={prepare}
              >
                Befliegung offline laden
              </Button>
            </>
          )}
          {!isOnline && selectedFlights.length > 0 && selectable.length > 0 && (
            <p className="text-xs text-slate-500">
              Zum Herunterladen wird eine Netzverbindung benötigt.
            </p>
          )}
        </>
      )}
    </section>
  );
}
