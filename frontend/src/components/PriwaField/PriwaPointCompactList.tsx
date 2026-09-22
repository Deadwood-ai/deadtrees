import {
  AimOutlined,
  CheckCircleFilled,
  EditOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { Button, Tooltip } from "antd";

import {
  getPriwaFundLabel,
  getPriwaPointSourceLabel,
  getPriwaPointTitle,
  isPriwaPointQaCandidate,
} from "./priwaPointQa";
import { formatPriwaReviewDate } from "./priwaReviewPresentation";
import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";

interface PriwaPointCompactListProps {
  points: IPriwaPoint[];
  groupByTreeId: Record<string, IPriwaBefallsgruppe>;
  onEditPoint: (point: IPriwaPoint) => void;
  onZoomToPoint: (point: IPriwaPoint) => void;
}

const sourceTone = {
  qr: "bg-emerald-100 text-emerald-800",
  gps: "bg-amber-100 text-amber-800",
  map: "bg-slate-200 text-slate-700",
} as const;

const Pill = ({ tone, children }: { tone: string; children: string }) => (
  <span
    className={`shrink-0 rounded px-1 text-[11px] font-semibold leading-4 ${tone}`}
  >
    {children}
  </span>
);

/**
 * Compact two-line rows matching the flight list: the row surface zooms to the
 * tree, the buttons on the right zoom or open the editor independently.
 */
export default function PriwaPointCompactList({
  points,
  groupByTreeId,
  onEditPoint,
  onZoomToPoint,
}: PriwaPointCompactListProps) {
  return (
    <div className="space-y-1 px-3 py-2">
      {points.map((point) => {
        const isQa = isPriwaPointQaCandidate(point);
        const group = groupByTreeId[point.id];
        const title = getPriwaPointTitle(point);
        return (
          <article
            key={point.id}
            data-testid="priwa-point-row"
            className="relative flex items-center gap-1 rounded-lg border border-slate-200 bg-white py-1.5 pl-3 pr-1"
          >
            {/* Hit surface underneath the text; the action buttons sit above it. */}
            <button
              type="button"
              className="absolute inset-0 z-0 cursor-pointer rounded-lg border-0 bg-transparent p-0 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 active:bg-slate-100"
              aria-label={`${title} auf Karte zeigen`}
              onClick={() => onZoomToPoint(point)}
            />
            <div className="pointer-events-none relative min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                {isQa ? (
                  <WarningFilled
                    className="shrink-0 text-amber-500"
                    aria-label="QA prüfen"
                  />
                ) : (
                  <CheckCircleFilled
                    className="shrink-0 text-emerald-600"
                    aria-label="Exakt"
                  />
                )}
                <span className="truncate text-sm font-semibold text-slate-950">
                  {title}
                </span>
                <Pill tone={sourceTone[point.coordinateSource]}>
                  {getPriwaPointSourceLabel(point)}
                </Pill>
                {point.syncStatus && point.syncStatus !== "synced" && (
                  <Pill
                    tone={
                      point.syncStatus === "failed"
                        ? "bg-red-100 text-red-800"
                        : "bg-sky-100 text-sky-800"
                    }
                  >
                    {point.syncStatus === "failed" ? "Fehler" : "Lokal"}
                  </Pill>
                )}
              </div>
              <div className="truncate text-xs text-slate-500">
                {getPriwaFundLabel(point)} · {point.baumart} · {point.name} ·{" "}
                {formatPriwaReviewDate(point.datum)}
                {group && (
                  <span className="text-emerald-700"> · {group.name}</span>
                )}
              </div>
            </div>
            <div className="relative flex shrink-0 items-center gap-0.5">
              <Tooltip title="Auf Karte zeigen">
                <Button
                  size="large"
                  type="text"
                  icon={<AimOutlined />}
                  aria-label="Punkt auf Karte zeigen"
                  onClick={() => onZoomToPoint(point)}
                />
              </Tooltip>
              <Tooltip title="Bearbeiten">
                <Button
                  size="large"
                  type="text"
                  icon={<EditOutlined />}
                  aria-label="Punkt bearbeiten"
                  onClick={() => onEditPoint(point)}
                />
              </Tooltip>
            </div>
          </article>
        );
      })}
    </div>
  );
}
