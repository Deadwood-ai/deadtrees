import { CloseOutlined, CloudDownloadOutlined } from "@ant-design/icons";
import { Alert, Button, Progress, Tooltip } from "antd";
import { useRef } from "react";

import { formatPriwaAreaKm2, formatPriwaMebibytes } from "./priwaFieldFlights";
import { PRIWA_OFFLINE_MOSAIC_LIMIT } from "./priwaOfflineMosaicPlan";
import type { IPriwaMosaic } from "./usePriwaMosaics";
import type { PriwaOfflineMosaicsState } from "./usePriwaOfflineMosaics";

interface PriwaFlightDownloadProps {
  offline: PriwaOfflineMosaicsState;
  flight: IPriwaMosaic;
  isOnline: boolean;
}

/** Preparation, confirmation and progress stay with the selected flight. */
export default function PriwaFlightDownload({
  offline,
  flight,
  isOnline,
}: PriwaFlightDownloadProps) {
  const requestedId = useRef<string | null>(null);
  const { entries, plans, progress, error, busy, supported } = offline;
  const plan =
    plans.length === 1 && plans[0].mosaic.id === flight.id ? plans[0] : null;
  const saved = entries.some(
    (entry) => entry.mosaic.id === flight.id && entry.available,
  );
  const wouldExceedCount =
    !entries.some((entry) => entry.mosaic.id === flight.id) &&
    entries.length >= PRIWA_OFFLINE_MOSAIC_LIMIT;
  const prepare = () => {
    requestedId.current = flight.id;
    void offline.plan([flight]);
  };

  if (!supported)
    return (
      <p className="mb-0 text-xs text-amber-700">
        Dieser Browser unterstützt keine Offline-Befliegungen.
      </p>
    );
  if (saved) return null;

  return (
    <div data-testid="priwa-flight-download" className="mt-2 space-y-2">
      {error && !busy && (plan || requestedId.current === flight.id) && (
        <Alert
          type="error"
          showIcon
          message={error}
          action={
            <Button
              size="small"
              disabled={!isOnline}
              onClick={plan ? () => void offline.download() : prepare}
            >
              Erneut versuchen
            </Button>
          }
        />
      )}
      {plan && progress ? (
        <div data-testid="priwa-offline-flight-progress">
          <div className="text-xs text-slate-600">
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
      ) : plan ? (
        <div data-testid="priwa-offline-flight-plan" className="space-y-1.5">
          <div className="text-xs text-slate-600">
            {formatPriwaMebibytes(plan.bytes)} ·{" "}
            {formatPriwaAreaKm2(plan.areaKm2)} · volle Auflösung
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="primary"
              icon={<CloudDownloadOutlined />}
              loading={busy}
              disabled={!isOnline}
              onClick={() => void offline.download()}
            >
              Jetzt herunterladen
            </Button>
            <Tooltip title="Verwerfen">
              <Button
                type="text"
                aria-label="Verwerfen"
                icon={<CloseOutlined />}
                disabled={busy}
                onClick={offline.clearPlan}
              />
            </Tooltip>
          </div>
        </div>
      ) : wouldExceedCount ? (
        <p className="mb-0 text-xs text-amber-700">
          Bitte zuerst eine gespeicherte Befliegung entfernen (höchstens{" "}
          {PRIWA_OFFLINE_MOSAIC_LIMIT}).
        </p>
      ) : (
        <Button
          icon={<CloudDownloadOutlined />}
          disabled={!isOnline || busy}
          loading={
            busy && requestedId.current === flight.id && plans.length === 0
          }
          onClick={prepare}
        >
          Befliegung offline laden
        </Button>
      )}
      {!isOnline && (
        <p className="mb-0 text-xs text-slate-500">
          Zum Herunterladen wird eine Netzverbindung benötigt.
        </p>
      )}
      {busy && !plan && plans.length > 0 && (
        <p className="mb-0 text-xs text-slate-500">
          Eine andere Befliegung wird gespeichert.
        </p>
      )}
    </div>
  );
}
