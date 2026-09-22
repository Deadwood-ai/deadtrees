import {
  AimOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { Alert, Button } from "antd";
import MobileMapSectionHeading from "../MapControls/mobile/MobileMapSectionHeading";
import { formatPriwaAreaKm2, formatPriwaMebibytes } from "./priwaFieldFlights";
import {
  PRIWA_OFFLINE_MOSAIC_AREA_KM2,
  PRIWA_OFFLINE_MOSAIC_BYTES,
  PRIWA_OFFLINE_MOSAIC_LIMIT,
} from "./priwaOfflineMosaicPlan";
import { formatPriwaReviewDate } from "./priwaReviewPresentation";
import type { PriwaOfflineMosaicsState } from "./usePriwaOfflineMosaics";

interface PriwaOfflineFlightSectionProps {
  offline: PriwaOfflineMosaicsState;
  onZoomToFlight: (mosaicId: string) => void;
}

/** Device library; downloading belongs to the selected flight above. */
export default function PriwaOfflineFlightSection({
  offline,
  onZoomToFlight,
}: PriwaOfflineFlightSectionProps) {
  const { entries, busy, persistent } = offline;
  const savedBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const savedArea = entries.reduce((sum, entry) => sum + entry.areaKm2, 0);
  return (
    <section data-testid="priwa-offline-flights" className="space-y-2">
      <MobileMapSectionHeading>Offline-Befliegungen</MobileMapSectionHeading>
      {offline.libraryError && (
        <Alert type="error" showIcon message={offline.libraryError} />
      )}
      {entries.length === 0 && (
        <p className="text-xs text-slate-500">Noch keine gespeichert.</p>
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
    </section>
  );
}
