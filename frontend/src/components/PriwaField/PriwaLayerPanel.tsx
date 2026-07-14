import { AimOutlined, TableOutlined } from "@ant-design/icons";
import { Button, Segmented, Switch, Tooltip, Typography } from "antd";
import { useEffect, useRef } from "react";

import type { IPriwaMatchedMosaic } from "./usePriwaMosaicMatches";
import type { IPriwaPoint } from "./types";
import type { IPriwaMosaic } from "./usePriwaMosaics";

export type PriwaBaseLayer = "aerial" | "topographic";

interface PriwaLayerPanelProps {
  baseLayer: PriwaBaseLayer;
  candidateMosaicCount: number;
  matchedMosaics: IPriwaMatchedMosaic[];
  enabledMosaicIds: ReadonlySet<string>;
  selectedMosaicId: string | null;
  hoveredMosaicId: string | null;
  isLoading: boolean;
  isOpen: boolean;
  errorMessage: string | null;
  onBaseLayerChange: (baseLayer: PriwaBaseLayer) => void;
  onSelectMosaic: (mosaicId: string) => void;
  onSetMosaicVisibility: (mosaicId: string, visible: boolean) => void;
  onZoomToMosaic: (mosaic: IPriwaMosaic) => void;
  onOpenPointInTable: (point: IPriwaPoint) => void;
}

const formatPriwaDate = (value: string | null | undefined) => {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
};

const daysApartLabel = ({ minDaysApart, maxDaysApart }: IPriwaMatchedMosaic) =>
  minDaysApart === maxDaysApart
    ? `${minDaysApart} ${minDaysApart === 1 ? "Tag" : "Tage"} Abstand`
    : `${minDaysApart}–${maxDaysApart} Tage Abstand`;

export default function PriwaLayerPanel({
  baseLayer,
  candidateMosaicCount,
  matchedMosaics,
  enabledMosaicIds,
  selectedMosaicId,
  hoveredMosaicId,
  isLoading,
  isOpen,
  errorMessage,
  onBaseLayerChange,
  onSelectMosaic,
  onSetMosaicVisibility,
  onZoomToMosaic,
  onOpenPointInTable,
}: PriwaLayerPanelProps) {
  const mosaicListRef = useRef<HTMLDivElement | null>(null);
  const visibleCount = matchedMosaics.filter(({ mosaic }) =>
    enabledMosaicIds.has(mosaic.id),
  ).length;

  useEffect(() => {
    if (!isOpen || !selectedMosaicId) return;
    const frame = window.requestAnimationFrame(() => {
      const selectedCard = mosaicListRef.current?.querySelector<HTMLElement>(
        `[data-mosaic-id="${CSS.escape(selectedMosaicId)}"]`,
      );
      selectedCard?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, selectedMosaicId]);

  return (
    <div className="w-[21rem] max-w-[calc(100vw-3rem)] space-y-3">
      <div>
        <Typography.Text strong>Layer</Typography.Text>
        <div className="text-xs text-gray-500">
          PRIWA Punkte bleiben immer sichtbar.
        </div>
      </div>
      <div>
        <div className="mb-1 text-sm font-medium text-gray-900">
          Kartenbasis
        </div>
        <Segmented<PriwaBaseLayer>
          block
          size="small"
          value={baseLayer}
          options={[
            { label: "Luftbild", value: "aerial" },
            { label: "Karte", value: "topographic" },
          ]}
          onChange={onBaseLayerChange}
        />
      </div>
      <div>
        <div className="text-sm font-medium text-gray-900">
          Umfeldbefliegungen
        </div>
        <div className="text-xs text-gray-500">
          {isLoading
            ? "Ordne Befliegungen den Bäumen zu..."
            : matchedMosaics.length > 0
              ? `${visibleCount} von ${matchedMosaics.length} Befliegung${
                  matchedMosaics.length === 1 ? "" : "en"
                } sichtbar`
              : candidateMosaicCount > 0
                ? "Keine räumlich und zeitlich passende Befliegung"
                : "Keine Drohnenlayer hinterlegt"}
        </div>
        {errorMessage && (
          <div className="mt-1 text-xs text-red-600">{errorMessage}</div>
        )}
        {matchedMosaics.length > 0 && (
          <div
            ref={mosaicListRef}
            className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1"
          >
            {matchedMosaics.map((matchedMosaic) => {
              const { mosaic, points } = matchedMosaic;
              const isVisible = enabledMosaicIds.has(mosaic.id);
              const isSelected = mosaic.id === selectedMosaicId;
              const isHovered = mosaic.id === hoveredMosaicId;
              const authors = mosaic.authors.length
                ? mosaic.authors.join(", ")
                : "Keine Autorenangabe";

              return (
                <div
                  key={mosaic.id}
                  data-mosaic-id={mosaic.id}
                  aria-current={isSelected ? "true" : undefined}
                  className={`rounded-md border bg-white px-2 py-2 ${
                    isSelected
                      ? "border-orange-500 ring-2 ring-orange-200"
                      : isHovered
                        ? "border-sky-500 ring-2 ring-sky-200"
                        : "border-slate-200"
                  }`}
                  onClick={() => onSelectMosaic(mosaic.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <div className="truncate text-sm font-medium text-slate-950">
                          {mosaic.label}
                        </div>
                        {isHovered && (
                          <span className="shrink-0 rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[0.65rem] font-medium uppercase leading-none text-sky-700">
                            Karte
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        Aufnahme:{" "}
                        {formatPriwaDate(mosaic.captureDate) ?? "ohne Datum"} ·
                        Upload:{" "}
                        {formatPriwaDate(mosaic.createdAt) ?? "ohne Datum"}
                      </div>
                      <div className="mt-0.5 text-xs font-medium text-emerald-700">
                        {points.length} Baum{points.length === 1 ? "" : "e"} ·{" "}
                        {daysApartLabel(matchedMosaic)}
                      </div>
                      <div className="mt-1.5 rounded border border-emerald-100 bg-emerald-50/70 px-2 py-1.5">
                        <div className="text-[0.7rem] font-semibold uppercase tracking-wide text-emerald-800">
                          Zugeordnete Käferbäume
                        </div>
                        <ul className="mt-1 space-y-0.5">
                          {points.map(({ point }) => (
                            <li key={point.id}>
                              <button
                                type="button"
                                className="group flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs transition hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
                                aria-label={`${point.baumnr ? `Baum ${point.baumnr}` : "Baum ohne Nummer"} in Käferbaumtabelle anzeigen`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onOpenPointInTable(point);
                                }}
                              >
                                <span className="min-w-0 flex-1 truncate font-medium text-slate-700 group-hover:text-emerald-800">
                                  {point.baumnr
                                    ? `Baum ${point.baumnr}`
                                    : "Ohne Baumnr"}
                                </span>
                                <span className="shrink-0 tabular-nums text-slate-500">
                                  {formatPriwaDate(point.datum) ?? "ohne Datum"}
                                </span>
                                <TableOutlined className="shrink-0 text-emerald-700" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Tooltip title="Kartengrenze anzeigen">
                        <Button
                          size="small"
                          icon={<AimOutlined />}
                          aria-label={`${mosaic.label} auf Karte zeigen`}
                          disabled={!mosaic.bbox}
                          onClick={(event) => {
                            event.stopPropagation();
                            onZoomToMosaic(mosaic);
                          }}
                        />
                      </Tooltip>
                      <Switch
                        size="small"
                        checked={isVisible}
                        aria-label={`${mosaic.label} anzeigen`}
                        onClick={(_, event) => event.stopPropagation()}
                        onChange={(checked) =>
                          onSetMosaicVisibility(mosaic.id, checked)
                        }
                      />
                    </div>
                  </div>
                  <details className="mt-1 text-xs text-slate-500">
                    <summary className="cursor-pointer select-none">
                      Details
                    </summary>
                    <dl className="mt-1 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
                      <dt className="text-slate-400">Autoren</dt>
                      <dd className="min-w-0 break-words">{authors}</dd>
                      <dt className="text-slate-400">Dataset ID</dt>
                      <dd className="min-w-0 break-all">{mosaic.id}</dd>
                      <dt className="text-slate-400">Kartengrenze</dt>
                      <dd>{mosaic.bbox ? "verfügbar" : "nicht verfügbar"}</dd>
                      {mosaic.additionalInformation && (
                        <>
                          <dt className="text-slate-400">Info</dt>
                          <dd className="min-w-0 break-words">
                            {mosaic.additionalInformation}
                          </dd>
                        </>
                      )}
                      <dt className="text-slate-400">COG</dt>
                      <dd className="min-w-0 break-all">{mosaic.cogUrl}</dd>
                    </dl>
                  </details>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
