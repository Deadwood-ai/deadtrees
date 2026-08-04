import {
  AimOutlined,
  CloseOutlined,
  EditOutlined,
  EnvironmentOutlined,
  QrcodeOutlined,
} from "@ant-design/icons";
import { Button, Tag } from "antd";

import { getPriwaCoordinateSourcePresentation } from "./priwaCoordinateSource";
import { getPriwaFundLabel, getPriwaPointTitle } from "./priwaPointQa";
import { formatPriwaReviewDate } from "./priwaReviewPresentation";
import type { IPriwaPoint } from "./types";

interface PriwaReviewTreeInspectorProps {
  point: IPriwaPoint;
  onClose: () => void;
  onEdit: (point: IPriwaPoint) => void;
  onFocus: (point: IPriwaPoint) => void;
}

const yesNoLabel = (value: string) => {
  if (value === "ja") return "Ja";
  if (value === "nein") return "Nein";
  if (value === "ja_kein_buchdrucker") return "Ja, kein Buchdrucker";
  return value;
};

const percentLabel = (value: string) =>
  value.replace("bis25%", "Bis 25%").replace("bis50%", "Bis 50%");

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 !text-left">
      <dt className="!text-left text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd className="m-0 mt-0.5 break-words !text-left text-sm text-slate-800">
        {value}
      </dd>
    </div>
  );
}

export default function PriwaReviewTreeInspector({
  point,
  onClose,
  onEdit,
  onFocus,
}: PriwaReviewTreeInspectorProps) {
  const source = getPriwaCoordinateSourcePresentation(point.coordinateSource);
  const positionConfirmed = point.coordinateSource === "qr";
  const sourceIcon =
    point.coordinateSource === "qr" ? (
      <QrcodeOutlined />
    ) : point.coordinateSource === "map" ? (
      <AimOutlined />
    ) : (
      <EnvironmentOutlined />
    );

  return (
    <div data-testid="priwa-tree-inspector" className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
            Ausgewählter Käferbaum
          </p>
          <h2 className="mt-1 truncate text-lg font-semibold text-slate-950">
            {getPriwaPointTitle(point)}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {point.baumart} · {formatPriwaReviewDate(point.datum)}
          </p>
        </div>
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined />}
          aria-label="Baumdetails schließen"
          onClick={onClose}
        />
      </header>

      <section
        className={`rounded-lg border p-3 ${
          positionConfirmed
            ? "border-emerald-200 bg-emerald-50"
            : "border-amber-200 bg-amber-50"
        }`}
      >
        <div className="flex items-start gap-2.5">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white ${
              positionConfirmed ? "bg-emerald-600" : "bg-amber-500"
            }`}
          >
            {sourceIcon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold text-slate-900">
                {source.detailLabel}
              </span>
              <Tag className="m-0" color={positionConfirmed ? "green" : "gold"}>
                {positionConfirmed ? "Bestätigt" : "Geschätzt"}
              </Tag>
            </div>
            <p className="mt-1 font-mono text-xs text-slate-600">
              {point.lat.toFixed(5)}, {point.lon.toFixed(5)}
            </p>
          </div>
          <Button
            size="small"
            icon={<AimOutlined />}
            aria-label="Baum auf Karte zeigen"
            onClick={() => onFocus(point)}
          />
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Baum
        </h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-slate-200 bg-white p-3">
          <Detail label="Baumnr" value={point.baumnr || "Ohne Baumnr"} />
          <Detail label="Fund" value={getPriwaFundLabel(point)} />
          <Detail label="Baumart" value={point.baumart} />
          <Detail label="Datum" value={formatPriwaReviewDate(point.datum)} />
          <Detail label="Aufnahme durch" value={point.name} />
        </dl>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Befallsmerkmale
        </h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-slate-200 bg-white p-3">
          <Detail label="Bohrmehl" value={yesNoLabel(point.bm)} />
          <Detail label="Bohrloch" value={yesNoLabel(point.bohrloch)} />
          <Detail label="Harz" value={point.harz} />
          <Detail
            label="Grüne Nadeln"
            value={yesNoLabel(point.grueneNadelnAmBoden)}
          />
          <Detail label="Nadelverfärbung" value={point.nadel} />
          <Detail label="Nadelverlust" value={percentLabel(point.kv)} />
          <Detail label="Rindenverlust" value={percentLabel(point.rinde)} />
        </dl>
      </section>

      {point.kom && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Kommentar
          </h3>
          <p className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">
            {point.kom}
          </p>
        </section>
      )}

      <Button
        block
        type="primary"
        icon={<EditOutlined />}
        onClick={() => onEdit(point)}
      >
        Käferbaum bearbeiten
      </Button>
    </div>
  );
}
