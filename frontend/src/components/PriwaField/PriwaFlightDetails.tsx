import { AimOutlined, EyeInvisibleOutlined } from "@ant-design/icons";
import { Button } from "antd";

import {
  formatPriwaFlightAuthors,
  type IPriwaFlightListItem,
} from "./priwaFieldFlights";
import { formatPriwaReviewDate } from "./priwaReviewPresentation";

interface PriwaFlightDetailsProps {
  primary: IPriwaFlightListItem;
  compare: IPriwaFlightListItem | null;
  onFit: (mosaicId: string) => void;
  onHide: (mosaicId: string) => void;
}

/** Details and actions for the orthomosaic currently shown on the field map. */
export default function PriwaFlightDetails({
  primary,
  compare,
  onFit,
  onHide,
}: PriwaFlightDetailsProps) {
  const { mosaic } = primary;
  const authors = formatPriwaFlightAuthors(mosaic.authors);

  return (
    <section
      data-testid="priwa-flight-details"
      className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3"
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
        Angezeigte Befliegung
      </div>
      <h3 className="mt-1 truncate text-base font-semibold text-slate-950">
        {mosaic.label}
      </h3>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-slate-600">
        <dt className="text-slate-400">Aufnahme</dt>
        <dd className="m-0">{formatPriwaReviewDate(mosaic.captureDate)}</dd>
        <dt className="text-slate-400">Upload</dt>
        <dd className="m-0">{formatPriwaReviewDate(mosaic.createdAt)}</dd>
        {authors && (
          <>
            <dt className="text-slate-400">Von</dt>
            <dd className="m-0 truncate">{authors}</dd>
          </>
        )}
        {primary.matchedTreeCount > 0 && (
          <>
            <dt className="text-slate-400">Käferbäume</dt>
            <dd className="m-0">{primary.matchedTreeCount} im Umfeld</dd>
          </>
        )}
        <dt className="text-slate-400">Quelle</dt>
        <dd className="m-0">
          {primary.offlineEntry?.available
            ? "Offline gespeichert, volle Auflösung"
            : "Online, volle Auflösung"}
        </dd>
      </dl>
      <div className="mt-3 flex gap-2">
        <Button
          type="primary"
          size="large"
          icon={<AimOutlined />}
          className="flex-1"
          onClick={() => onFit(mosaic.id)}
        >
          Auf Befliegung zoomen
        </Button>
        <Button
          size="large"
          icon={<EyeInvisibleOutlined />}
          aria-label={`${mosaic.label} ausblenden`}
          onClick={() => onHide(mosaic.id)}
        />
      </div>
      {compare && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-white/80 px-3 py-2 text-xs text-slate-700">
          <span className="min-w-0 truncate">
            Vergleich: <strong>{compare.mosaic.label}</strong> ·{" "}
            {formatPriwaReviewDate(compare.mosaic.captureDate)}
          </span>
          <Button
            type="text"
            size="small"
            icon={<AimOutlined />}
            aria-label={`Auf ${compare.mosaic.label} zoomen`}
            onClick={() => onFit(compare.mosaic.id)}
          />
        </div>
      )}
    </section>
  );
}
