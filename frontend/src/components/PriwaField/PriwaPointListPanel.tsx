import {
  AimOutlined,
  CheckCircleFilled,
  EditOutlined,
  EnvironmentOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { Button, Empty, Segmented, Tag } from "antd";
import { useMemo, useState } from "react";

import {
  getPriwaFundLabel,
  getPriwaPointSourceLabel,
  getPriwaPointTitle,
  isPriwaPointQaCandidate,
} from "./priwaPointQa";
import type { IPriwaPoint } from "./types";

type PriwaPointFilter = "all" | "qa";

interface PriwaPointListPanelProps {
  points: IPriwaPoint[];
  projectName: string;
  isLoading?: boolean;
  onClose: () => void;
  onEditPoint: (point: IPriwaPoint) => void;
  onZoomToPoint: (point: IPriwaPoint) => void;
}

export default function PriwaPointListPanel({
  points,
  projectName,
  isLoading = false,
  onClose,
  onEditPoint,
  onZoomToPoint,
}: PriwaPointListPanelProps) {
  const [filter, setFilter] = useState<PriwaPointFilter>("all");
  const qaPoints = useMemo(
    () => points.filter(isPriwaPointQaCandidate),
    [points],
  );
  const exactCount = points.filter(
    (point) => point.coordinateSource === "qr",
  ).length;
  const visiblePoints = filter === "qa" ? qaPoints : points;
  const emptyDescription =
    isLoading
      ? "Lade Punkte..."
      : filter === "qa" && points.length > 0
        ? "Keine QA-Punkte"
        : "Keine Punkte";

  return (
    <section className="pointer-events-auto absolute inset-x-2 bottom-2 z-[58] flex max-h-[50dvh] flex-col overflow-hidden rounded-md bg-white shadow-xl ring-1 ring-slate-900/10 md:bottom-5 md:left-4 md:right-auto md:top-24 md:w-[390px] md:max-h-[calc(100dvh-8rem)]">
      <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-950">Käferbaum QA</div>
          <div className="truncate text-xs text-slate-500">{projectName}</div>
        </div>
        <Button size="small" onClick={onClose}>
          Schließen
        </Button>
      </header>

      <div className="grid grid-cols-3 border-b border-slate-200 text-center text-xs">
        <div className="px-2 py-2">
          <div className="text-base font-semibold text-slate-950">{points.length}</div>
          <div className="text-slate-500">Gesamt</div>
        </div>
        <div className="border-x border-slate-200 px-2 py-2">
          <div className="text-base font-semibold text-emerald-700">{exactCount}</div>
          <div className="text-slate-500">Exakt</div>
        </div>
        <div className="px-2 py-2">
          <div className="text-base font-semibold text-amber-700">{qaPoints.length}</div>
          <div className="text-slate-500">QA</div>
        </div>
      </div>

      <div className="border-b border-slate-200 px-3 py-2">
        <Segmented
          block
          size="small"
          value={filter}
          onChange={(value) => setFilter(value as PriwaPointFilter)}
          options={[
            { label: "Alle", value: "all" },
            { label: "QA prüfen", value: "qa" },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visiblePoints.length === 0 ? (
          <div className="px-3 py-8">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={emptyDescription}
            />
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {visiblePoints.map((point) => {
              const isQa = isPriwaPointQaCandidate(point);
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
                      <span className="text-xs text-slate-500">{point.baumart}</span>
                      <span className="text-xs text-slate-400">·</span>
                      <span className="text-xs text-slate-500">{point.name}</span>
                    </div>
                    <div className="mt-1 truncate text-xs text-slate-500">
                      {point.lat.toFixed(5)}, {point.lon.toFixed(5)} ·{" "}
                      {point.datum}
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
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-slate-200 px-3 py-2 text-xs text-slate-500">
        <EnvironmentOutlined />
        <span>QA markiert geschätzte Lagen oder Punkte ohne Baumnr.</span>
      </footer>
    </section>
  );
}
