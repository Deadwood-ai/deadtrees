import {
  ColumnWidthOutlined,
  DownloadOutlined,
  EnvironmentOutlined,
} from "@ant-design/icons";
import { Button, Empty, Segmented } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import PriwaPointCompactList from "./PriwaPointCompactList";
import PriwaPointTable from "./PriwaPointTable";
import { indexPriwaBefallsgruppenByTreeId } from "./priwaBefallsgruppenState";
import { downloadPriwaPointsCsv } from "./priwaPointCsv";
import { isPriwaPointQaCandidate } from "./priwaPointQa";
import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";

type PriwaPointFilter = "all" | "qa";
type PriwaPointView = "list" | "table";

const PRIWA_POINT_VIEW_STORAGE_KEY = "deadtrees-priwa-field:point-view";
const DEFAULT_DESKTOP_PANEL_WIDTH = "calc(100vw - 2rem)";
const MIN_DESKTOP_PANEL_WIDTH = 560;
const DESKTOP_PANEL_VIEWPORT_MARGIN = 32;
const KEYBOARD_RESIZE_STEP = 32;

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
  groups: IPriwaBefallsgruppe[];
  projectName: string;
  isLoading?: boolean;
  focusedPointId?: string | null;
  onClose: () => void;
  onEditPoint: (point: IPriwaPoint) => void;
  onZoomToPoint: (point: IPriwaPoint) => void;
}

export default function PriwaPointListPanel({
  points,
  groups,
  projectName,
  isLoading = false,
  focusedPointId = null,
  onClose,
  onEditPoint,
  onZoomToPoint,
}: PriwaPointListPanelProps) {
  const [filter, setFilter] = useState<PriwaPointFilter>("all");
  const [view, setView] = useState<PriwaPointView>(loadInitialPointView);
  const panelRef = useRef<HTMLElement | null>(null);
  const desktopPanelWidthRef = useRef<number | null>(null);
  const pendingDesktopPanelWidthRef = useRef<number | null>(null);
  const resizeAnimationFrameRef = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const resizeStartRef = useRef<{ clientX: number; width: number } | null>(
    null,
  );
  const groupByTreeId = useMemo(
    () => indexPriwaBefallsgruppenByTreeId(groups),
    [groups],
  );
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

  const clampDesktopPanelWidth = useCallback((width: number) => {
    const maxWidth = Math.max(
      MIN_DESKTOP_PANEL_WIDTH,
      window.innerWidth - DESKTOP_PANEL_VIEWPORT_MARGIN,
    );
    return Math.min(maxWidth, Math.max(MIN_DESKTOP_PANEL_WIDTH, width));
  }, []);

  const resizeDesktopPanel = useCallback(
    (width: number) => {
      pendingDesktopPanelWidthRef.current = clampDesktopPanelWidth(width);
      if (resizeAnimationFrameRef.current !== null) return;

      resizeAnimationFrameRef.current = window.requestAnimationFrame(() => {
        const nextWidth = pendingDesktopPanelWidthRef.current;
        if (nextWidth !== null) {
          desktopPanelWidthRef.current = nextWidth;
          panelRef.current?.style.setProperty(
            "--priwa-point-panel-width",
            `${nextWidth}px`,
          );
        }
        resizeAnimationFrameRef.current = null;
      });
    },
    [clampDesktopPanelWidth],
  );

  const startDesktopResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panelWidth = panelRef.current?.getBoundingClientRect().width;
    if (!panelWidth) return;

    resizeStartRef.current = { clientX: event.clientX, width: panelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const continueDesktopResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeStart = resizeStartRef.current;
    if (!resizeStart) return;

    resizeDesktopPanel(
      resizeStart.width + (event.clientX - resizeStart.clientX),
    );
  };

  const finishDesktopResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizeStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizeDesktopPanelWithKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

    const currentWidth = panelRef.current?.getBoundingClientRect().width;
    if (!currentWidth) return;

    resizeDesktopPanel(
      currentWidth +
        (event.key === "ArrowRight"
          ? KEYBOARD_RESIZE_STEP
          : -KEYBOARD_RESIZE_STEP),
    );
    event.preventDefault();
  };

  const getTableScrollContainer = useCallback(
    () => contentRef.current ?? window,
    [],
  );

  const panelStyle = {
    "--priwa-point-panel-width": desktopPanelWidthRef.current
      ? `${desktopPanelWidthRef.current}px`
      : DEFAULT_DESKTOP_PANEL_WIDTH,
  } as CSSProperties;

  useEffect(
    () => () => {
      if (resizeAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeAnimationFrameRef.current);
      }
    },
    [],
  );

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
    <section
      ref={panelRef}
      data-testid="priwa-point-list-panel"
      style={panelStyle}
      className="pointer-events-auto absolute inset-x-2 bottom-2 z-[58] flex max-h-[64dvh] flex-col overflow-hidden rounded-md bg-white shadow-xl ring-1 ring-slate-900/10 md:bottom-5 md:left-4 md:right-auto md:top-24 md:w-[var(--priwa-point-panel-width)] md:max-w-[calc(100vw-2rem)] md:max-h-[calc(100dvh-8rem)]"
    >
      <div
        role="separator"
        aria-label="Tabellenbreite ändern"
        aria-orientation="vertical"
        tabIndex={0}
        title="Tabellenbreite ändern"
        data-testid="priwa-point-list-resize-handle"
        className="absolute right-0 top-1/2 z-10 hidden h-14 w-6 -translate-y-1/2 cursor-col-resize touch-none items-center justify-center rounded-l-md border border-r-0 border-slate-300 bg-white/95 text-slate-500 shadow-sm outline-none hover:border-emerald-500 hover:text-emerald-700 focus-visible:border-emerald-500 focus-visible:text-emerald-700 md:flex"
        onPointerDown={startDesktopResize}
        onPointerMove={continueDesktopResize}
        onPointerUp={finishDesktopResize}
        onPointerCancel={finishDesktopResize}
        onLostPointerCapture={() => {
          resizeStartRef.current = null;
        }}
        onKeyDown={resizeDesktopPanelWithKeyboard}
      >
        <ColumnWidthOutlined />
      </div>
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
            groupByTreeId={groupByTreeId}
            onEditPoint={onEditPoint}
            onZoomToPoint={onZoomToPoint}
          />
        ) : (
          <PriwaPointTable
            points={visiblePoints}
            groupByTreeId={groupByTreeId}
            focusedPointId={focusedPointId}
            getScrollContainer={getTableScrollContainer}
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
