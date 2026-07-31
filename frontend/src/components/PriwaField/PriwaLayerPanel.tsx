import { Divider, Segmented, Typography } from "antd";
import { useEffect, useRef } from "react";

import PriwaFlightCard from "./PriwaFlightCard";
import type {
  IPriwaMatchedMosaic,
  IPriwaUnmatchedMosaic,
} from "./usePriwaMosaicMatches";
import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";
import type { IPriwaMosaic, PriwaFlightType } from "./usePriwaMosaics";

export type PriwaBaseLayer = "aerial" | "topographic";

export interface PriwaLayerPanelProps {
  variant?: "popover" | "sheet";
  baseLayer: PriwaBaseLayer;
  candidateMosaicCount: number;
  matchedMosaics: IPriwaMatchedMosaic[];
  unmatchedMosaics: IPriwaUnmatchedMosaic[];
  excludedMosaics: IPriwaMosaic[];
  groups: IPriwaBefallsgruppe[];
  enabledMosaicIds: ReadonlySet<string>;
  selectedMosaicId: string | null;
  hoveredMosaicId: string | null;
  isLoading: boolean;
  isOpen: boolean;
  isClassifyingFlight: boolean;
  errorMessage: string | null;
  onBaseLayerChange: (baseLayer: PriwaBaseLayer) => void;
  onSelectMosaic: (mosaicId: string) => void;
  onSetMosaicVisibility: (mosaicId: string, visible: boolean) => void;
  onSetFlightType: (
    mosaicId: string,
    flightType: PriwaFlightType,
  ) => Promise<void>;
  onAssignMosaicToGroup: (
    mosaic: IPriwaMosaic,
    groupId: string,
  ) => Promise<void>;
  onCreateGroupForMosaic: (mosaic: IPriwaMosaic) => void;
  onZoomToMosaic: (mosaic: IPriwaMosaic) => void;
  onOpenPointInTable: (point: IPriwaPoint) => void;
}

export default function PriwaLayerPanel({
  variant = "popover",
  baseLayer,
  candidateMosaicCount,
  matchedMosaics,
  unmatchedMosaics,
  excludedMosaics,
  groups,
  enabledMosaicIds,
  selectedMosaicId,
  hoveredMosaicId,
  isLoading,
  isOpen,
  isClassifyingFlight,
  errorMessage,
  onBaseLayerChange,
  onSelectMosaic,
  onSetMosaicVisibility,
  onSetFlightType,
  onAssignMosaicToGroup,
  onCreateGroupForMosaic,
  onZoomToMosaic,
  onOpenPointInTable,
}: PriwaLayerPanelProps) {
  const isSheet = variant === "sheet";
  const mosaicListRef = useRef<HTMLDivElement | null>(null);
  const visibleCount = [...matchedMosaics, ...unmatchedMosaics].filter(
    ({ mosaic }) => enabledMosaicIds.has(mosaic.id),
  ).length;

  useEffect(() => {
    if (!isOpen || !selectedMosaicId) return;
    const frame = window.requestAnimationFrame(() => {
      mosaicListRef.current
        ?.querySelector<HTMLElement>(
          `[data-mosaic-id="${CSS.escape(selectedMosaicId)}"]`,
        )
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, selectedMosaicId]);

  const renderFlightCard = (
    mosaic: IPriwaMosaic,
    match?: IPriwaMatchedMosaic,
    unmatched?: IPriwaUnmatchedMosaic,
  ) => (
    <PriwaFlightCard
      key={mosaic.id}
      mosaic={mosaic}
      match={match}
      unmatched={unmatched}
      groups={groups}
      isVisible={enabledMosaicIds.has(mosaic.id)}
      isSelected={mosaic.id === selectedMosaicId}
      isHovered={mosaic.id === hoveredMosaicId}
      isClassifyingFlight={isClassifyingFlight}
      onSelect={() => onSelectMosaic(mosaic.id)}
      onSetVisibility={(visible) => onSetMosaicVisibility(mosaic.id, visible)}
      onSetFlightType={(flightType) => onSetFlightType(mosaic.id, flightType)}
      onAssignToGroup={(groupId) => onAssignMosaicToGroup(mosaic, groupId)}
      onCreateGroup={() => onCreateGroupForMosaic(mosaic)}
      onZoomToMosaic={() => onZoomToMosaic(mosaic)}
      onOpenPointInTable={onOpenPointInTable}
    />
  );

  return (
    <div
      className={
        isSheet
          ? "w-full space-y-3"
          : "w-[23rem] max-w-[calc(100vw-3rem)] space-y-3"
      }
    >
      <div>
        {!isSheet && <Typography.Text strong>Layer</Typography.Text>}
        <div className="text-xs text-gray-500">
          Kartenklick öffnet eine Befliegung. Sichtbarkeit und Zuordnung werden
          hier gesteuert.
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

      <details className="rounded border border-sky-100 bg-sky-50/70 px-2 py-1.5 text-xs text-sky-950">
        <summary className="cursor-pointer font-semibold">
          Was ist neu? Hinweise für Umfeldbefliegungen
        </summary>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>Vorschläge entstehen aus Lage und Aufnahmedatum.</li>
          <li>Zuordnung und PRIWA-Relevanz können hier korrigiert werden.</li>
          <li>
            Für gute Orthofotos: senkrecht aufnehmen, Fläche vollständig
            abdecken sowie genügend Flughöhe und Bildüberlappung wählen.
          </li>
          <li>Vor der Zuordnung Vorschau, Lage und Datum prüfen.</li>
        </ul>
      </details>

      {errorMessage && (
        <div className="text-xs text-red-600">{errorMessage}</div>
      )}
      <div className="text-xs text-gray-500">
        {isLoading
          ? "Befliegungen werden geladen und zugeordnet…"
          : `${visibleCount} sichtbar · ${candidateMosaicCount} PRIWA-Kandidat${
              candidateMosaicCount === 1 ? "" : "en"
            }`}
      </div>

      <div
        ref={mosaicListRef}
        className={
          isSheet ? "space-y-3" : "max-h-[32rem] space-y-3 overflow-y-auto pr-1"
        }
      >
        <section>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-emerald-800">
            Zugeordnet ({matchedMosaics.length})
          </div>
          <div className="space-y-2">
            {matchedMosaics.map((match) =>
              renderFlightCard(match.mosaic, match),
            )}
            {!isLoading && matchedMosaics.length === 0 && (
              <div className="text-xs text-slate-500">
                Noch keine Befliegung zugeordnet.
              </div>
            )}
          </div>
        </section>

        <Divider className="my-2" />
        <section>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800">
            Noch nicht zugeordnet ({unmatchedMosaics.length})
          </div>
          <div className="space-y-2">
            {unmatchedMosaics.map((unmatched) =>
              renderFlightCard(unmatched.mosaic, undefined, unmatched),
            )}
            {!isLoading && unmatchedMosaics.length === 0 && (
              <div className="text-xs text-slate-500">
                Alle PRIWA-Kandidaten sind zugeordnet.
              </div>
            )}
          </div>
        </section>

        {excludedMosaics.length > 0 && (
          <>
            <Divider className="my-2" />
            <details>
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-600">
                Ausgeschlossen ({excludedMosaics.length})
              </summary>
              <div className="mt-2 space-y-2">
                {excludedMosaics.map((mosaic) => renderFlightCard(mosaic))}
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
