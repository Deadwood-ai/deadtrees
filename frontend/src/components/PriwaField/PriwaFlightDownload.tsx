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

/**
 * Offline download of the selected flight, rendered into the pinned card's
 * grid: the first child is the action button beside zoom and visibility, the
 * remaining children are full-width status lines. Size confirmation, progress
 * and errors only ever belong to `flight`; another flight's pending plan or
 * running download shows up as a short note instead.
 */
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
  const isDownloading = !!plan && !!progress;
  const isOwnRequest = requestedId.current === flight.id;
  const isOtherFlightBusy = busy && !plan && plans.length > 0;
  const prepare = () => {
    requestedId.current = flight.id;
    void offline.plan([flight]);
  };
  const download = () => {
    requestedId.current = flight.id;
    void offline.download();
  };

  if (!supported)
    return (
      <p className="col-span-full mb-0 text-xs text-amber-700">
        Dieser Browser unterstützt keine Offline-Befliegungen.
      </p>
    );
  if (saved) return null;

  const action = isDownloading ? (
    <Tooltip title="Download abbrechen">
      <Button
        size="large"
        type="text"
        danger
        icon={<CloseOutlined />}
        aria-label="Download abbrechen"
        onClick={offline.cancel}
      />
    </Tooltip>
  ) : plan ? (
    <Tooltip title="Vorbereitung verwerfen">
      <Button
        size="large"
        type="primary"
        icon={<CloudDownloadOutlined />}
        aria-label="Offline-Download verwerfen"
        aria-pressed
        disabled={busy}
        loading={busy && isOwnRequest}
        onClick={offline.clearPlan}
      />
    </Tooltip>
  ) : (
    <Tooltip title="Befliegung offline laden">
      <Button
        size="large"
        type="text"
        icon={<CloudDownloadOutlined />}
        aria-label="Befliegung offline laden"
        disabled={!isOnline || busy || wouldExceedCount}
        loading={busy && isOwnRequest}
        onClick={prepare}
      />
    </Tooltip>
  );

  return (
    <div data-testid="priwa-flight-download" className="contents">
      {action}
      {isDownloading ? (
        <div
          data-testid="priwa-offline-flight-progress"
          className="col-span-full pr-2"
        >
          <div className="flex items-baseline justify-between gap-2 text-xs text-slate-600">
            <span className="truncate">{progress.label} wird gespeichert</span>
            <span className="shrink-0 tabular-nums">
              {formatPriwaMebibytes(progress.downloadedBytes)} von{" "}
              {formatPriwaMebibytes(progress.totalBytes)}
            </span>
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
            showInfo={false}
          />
        </div>
      ) : plan ? (
        <div
          data-testid="priwa-offline-flight-plan"
          className="col-span-full flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-700"
        >
          <span className="min-w-0 flex-1 whitespace-nowrap">
            {formatPriwaMebibytes(plan.bytes)} ·{" "}
            {formatPriwaAreaKm2(plan.areaKm2)} · volle Auflösung
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Button
              type="primary"
              size="small"
              loading={busy && isOwnRequest}
              disabled={!isOnline || busy}
              onClick={download}
            >
              Jetzt herunterladen
            </Button>
            <Tooltip title="Verwerfen">
              <Button
                type="text"
                size="small"
                aria-label="Verwerfen"
                icon={<CloseOutlined />}
                disabled={busy}
                onClick={offline.clearPlan}
              />
            </Tooltip>
          </span>
        </div>
      ) : wouldExceedCount ? (
        <p className="col-span-full mb-0 text-xs text-amber-700">
          Bitte zuerst eine gespeicherte Befliegung entfernen (höchstens{" "}
          {PRIWA_OFFLINE_MOSAIC_LIMIT}).
        </p>
      ) : isOtherFlightBusy ? (
        <p className="col-span-full mb-0 text-xs text-slate-500">
          Eine andere Befliegung wird gespeichert.
        </p>
      ) : !isOnline ? (
        <p className="col-span-full mb-0 text-xs text-slate-500">
          Zum Herunterladen wird eine Netzverbindung benötigt.
        </p>
      ) : null}
      {error && !busy && (plan || isOwnRequest) && (
        <Alert
          className="col-span-full"
          type="error"
          showIcon
          message={error}
          action={
            <Button
              size="small"
              disabled={!isOnline}
              onClick={plan ? download : prepare}
            >
              Erneut versuchen
            </Button>
          }
        />
      )}
    </div>
  );
}
