import { DownloadOutlined, EnvironmentOutlined } from "@ant-design/icons";
import { Button, Empty, Segmented } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

import PriwaPointCompactList from "./PriwaPointCompactList";
import PriwaPointTable from "./PriwaPointTable";
import { downloadPriwaPointsCsv } from "./priwaPointCsv";
import { isPriwaPointQaCandidate } from "./priwaPointQa";
import type { IPriwaPoint } from "./types";

type PriwaPointFilter = "all" | "qa";
type PriwaPointView = "list" | "table";

const PRIWA_POINT_VIEW_STORAGE_KEY = "deadtrees-priwa-field:point-view";

const loadInitialPointView = (): PriwaPointView => {
  if (typeof window === "undefined") return "table";

  try {
    const storedView = window.localStorage.getItem(
      PRIWA_POINT_VIEW_STORAGE_KEY,
    );
    if (storedView === "list" || storedView === "table") return storedView;
  } catch {
    // Local storage may be unavailable in privacy-restricted browsers.
  }

  return window.matchMedia("(max-width: 767px)").matches ? "list" : "table";
};

interface PriwaPointListPanelProps {
  points: IPriwaPoint[];
  projectName: string;
  isLoading?: boolean;
  focusedPointId?: string | null;
  onClose: () => void;
  onEditPoint: (point: IPriwaPoint) => void;
  onZoomToPoint: (point: IPriwaPoint) => void;
}

export default function PriwaPointListPanel({
  points,
  projectName,
  isLoading = false,
  focusedPointId = null,
  onClose,
  onEditPoint,
  onZoomToPoint,
}: PriwaPointListPanelProps) {
  const [filter, setFilter] = useState<PriwaPointFilter>("all");
  const [view, setView] = useState<PriwaPointView>(loadInitialPointView);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const qaPoints = useMemo(
    () => points.filter(isPriwaPointQaCandidate),
    [points],
  );
  const exactCount = points.filter(
    (point) => point.coordinateSource === "qr",
  ).length;
  const visiblePoints = filter === "qa" ? qaPoints : points;
  const focusedPoint = useMemo(
    () => points.find((point) => point.id === focusedPointId) ?? null,
    [focusedPointId, points],
  );
  const pendingSyncCount = points.filter(
    (point) => point.syncStatus && point.syncStatus !== "synced",
  ).length;
  const emptyDescription = isLoading
    ? "Lade Punkte..."
    : filter === "qa" && points.length > 0
      ? "Keine QA-Punkte"
      : "Keine Punkte";

  const changeView = (nextView: PriwaPointView) => {
    setView(nextView);
    try {
      window.localStorage.setItem(PRIWA_POINT_VIEW_STORAGE_KEY, nextView);
    } catch {
      // The selected view still applies for the current session.
    }
  };

  useEffect(() => {
    if (!focusedPointId) return;

    setFilter("all");
    setView("table");
  }, [focusedPointId]);

  useEffect(() => {
    if (!focusedPointId || view !== "table" || filter !== "all") return;

    const frame = window.requestAnimationFrame(() => {
      const focusedRow = Array.from(
        contentRef.current?.querySelectorAll<HTMLElement>("[data-row-key]") ??
          [],
      ).find((row) => row.dataset.rowKey === focusedPointId);

      focusedRow?.scrollIntoView({ block: "center" });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [filter, focusedPointId, view, visiblePoints]);

  return (
    <section className="pointer-events-auto absolute inset-x-2 bottom-2 z-[58] flex max-h-[64dvh] flex-col overflow-hidden rounded-md bg-white shadow-xl ring-1 ring-slate-900/10 md:bottom-5 md:left-4 md:right-4 md:top-24 md:max-h-[calc(100dvh-8rem)]">
      <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-950">Käferbäume</div>
          <div className="truncate text-xs text-slate-500">
            {projectName}
            {pendingSyncCount > 0 ? ` · ${pendingSyncCount} lokal` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="small"
            icon={<DownloadOutlined />}
            disabled={points.length === 0}
            onClick={() => downloadPriwaPointsCsv(points, projectName)}
          >
            CSV
          </Button>
          <Button size="small" onClick={onClose}>
            Schließen
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-3 border-b border-slate-200 text-center text-xs">
        <div className="px-2 py-2">
          <div className="text-base font-semibold text-slate-950">
            {points.length}
          </div>
          <div className="text-slate-500">Gesamt</div>
        </div>
        <div className="border-x border-slate-200 px-2 py-2">
          <div className="text-base font-semibold text-emerald-700">
            {exactCount}
          </div>
          <div className="text-slate-500">Exakt</div>
        </div>
        <div className="px-2 py-2">
          <div className="text-base font-semibold text-amber-700">
            {qaPoints.length}
          </div>
          <div className="text-slate-500">QA</div>
        </div>
      </div>

      <div className="grid gap-2 border-b border-slate-200 px-3 py-2 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium text-slate-500">Ansicht</div>
          <Segmented<PriwaPointView>
            aria-label="Punktlistenansicht"
            block
            size="small"
            value={view}
            onChange={changeView}
            options={[
              { label: "Liste", value: "list" },
              { label: "Tabelle", value: "table" },
            ]}
          />
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-slate-500">Filter</div>
          <Segmented<PriwaPointFilter>
            aria-label="Punktlistenfilter"
            block
            size="small"
            value={filter}
            onChange={setFilter}
            options={[
              { label: "Alle", value: "all" },
              { label: "QA prüfen", value: "qa" },
            ]}
          />
        </div>
      </div>

      {focusedPoint && (
        <div className="border-b border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          Aus Umfeldbefliegung geöffnet:{" "}
          <strong>
            {focusedPoint.baumnr
              ? `Baum ${focusedPoint.baumnr}`
              : "Baum ohne Nummer"}
          </strong>{" "}
          ist in der Tabelle hervorgehoben.
        </div>
      )}

      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
        {visiblePoints.length === 0 ? (
          <div className="px-3 py-8">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={emptyDescription}
            />
          </div>
        ) : view === "list" ? (
          <PriwaPointCompactList
            points={visiblePoints}
            onEditPoint={onEditPoint}
            onZoomToPoint={onZoomToPoint}
          />
        ) : (
          <PriwaPointTable
            points={visiblePoints}
            focusedPointId={focusedPointId}
            onEditPoint={onEditPoint}
            onZoomToPoint={onZoomToPoint}
          />
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-slate-200 px-3 py-2 text-xs text-slate-500">
        <EnvironmentOutlined />
        <span>QA markiert geschätzte Lagen oder Punkte ohne Baumnr.</span>
      </footer>
    </section>
  );
}
