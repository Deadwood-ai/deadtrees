import {
  AimOutlined,
  CheckCircleFilled,
  EditOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { Button, Tag } from "antd";

import {
  getPriwaFundLabel,
  getPriwaPointSourceLabel,
  getPriwaPointTitle,
  isPriwaPointQaCandidate,
} from "./priwaPointQa";
import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";

interface PriwaPointCompactListProps {
  points: IPriwaPoint[];
  groupByTreeId: Record<string, IPriwaBefallsgruppe>;
  onEditPoint: (point: IPriwaPoint) => void;
  onZoomToPoint: (point: IPriwaPoint) => void;
}

export default function PriwaPointCompactList({
  points,
  groupByTreeId,
  onEditPoint,
  onZoomToPoint,
}: PriwaPointCompactListProps) {
  return (
    <div className="divide-y divide-slate-100">
      {points.map((point) => {
        const isQa = isPriwaPointQaCandidate(point);
        const group = groupByTreeId[point.id];
        return (
          <article
            key={point.id}
            className="grid grid-cols-[1fr_auto] gap-2 px-3 py-2.5"
          >
            <button
              type="button"
              className="min-w-0 text-left"
              onClick={() => onZoomToPoint(point)}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                {isQa ? (
                  <WarningFilled className="shrink-0 text-amber-500" />
                ) : (
                  <CheckCircleFilled className="shrink-0 text-emerald-600" />
                )}
                <span className="truncate text-sm font-semibold text-slate-950">
                  {getPriwaPointTitle(point)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Tag
                  className="m-0"
                  color={point.coordinateSource === "qr" ? "green" : "gold"}
                >
                  {getPriwaPointSourceLabel(point)}
                </Tag>
                <Tag className="m-0">{getPriwaFundLabel(point)}</Tag>
                {group && (
                  <Tag className="m-0" color="green">
                    {group.name}
                  </Tag>
                )}
                {point.syncStatus && point.syncStatus !== "synced" && (
                  <Tag
                    className="m-0"
                    color={point.syncStatus === "failed" ? "red" : "blue"}
                  >
                    {point.syncStatus === "failed" ? "Fehler" : "Lokal"}
                  </Tag>
                )}
                <span className="text-xs text-slate-500">{point.baumart}</span>
                <span className="text-xs text-slate-400">·</span>
                <span className="text-xs text-slate-500">{point.name}</span>
              </div>
              <div className="mt-1 truncate text-xs text-slate-500">
                {point.lat.toFixed(5)}, {point.lon.toFixed(5)} · {point.datum}
              </div>
            </button>
            <div className="flex items-start gap-1">
              <Button
                aria-label="Punkt auf Karte zeigen"
                icon={<AimOutlined />}
                size="small"
                onClick={() => onZoomToPoint(point)}
              />
              <Button
                aria-label="Punkt bearbeiten"
                icon={<EditOutlined />}
                size="small"
                onClick={() => onEditPoint(point)}
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}
