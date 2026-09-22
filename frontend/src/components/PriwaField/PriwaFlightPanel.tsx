import { CloseOutlined, DisconnectOutlined } from "@ant-design/icons";
import { Button, Input, Select } from "antd";
import { useRef, useState, type ReactNode } from "react";
import MapPanelScrollArea from "../MapControls/mobile/MapPanelScrollArea";

import MobileBottomSheet from "../MapControls/mobile/MobileBottomSheet";
import MobileMapSectionHeading from "../MapControls/mobile/MobileMapSectionHeading";
import PriwaFlightDetails from "./PriwaFlightDetails";
import PriwaFlightList from "./PriwaFlightList";
import {
  filterPriwaFlightItems,
  type PriwaFlightSort,
  type IPriwaFlightListItem,
} from "./priwaFieldFlights";
import type { PriwaFlightPanelPlacement } from "./priwaFieldLayout";

interface PriwaFlightPanelProps {
  open: boolean;
  placement: PriwaFlightPanelPlacement;
  items: IPriwaFlightListItem[];
  isLoading: boolean;
  isOnline: boolean;
  offlineSection?: ReactNode;
  onClose: () => void;
  onShow: (mosaicId: string) => void;
  onSelect: (mosaicId: string) => void;
  selectedItem: IPriwaFlightListItem | null;
  mapCenter: number[] | null;
  onHide: (mosaicId: string) => void;
  onFit: (mosaicId: string) => void;
}

const PANEL_TITLE = "Befliegungen";

/**
 * Field-layout flight chooser: a bottom sheet in portrait, a side panel in
 * landscape. Lists every PRIWA orthomosaic of the project independent of the
 * review groups, with independent selection, visibility and zoom actions.
 */
export default function PriwaFlightPanel({
  open,
  placement,
  items,
  isLoading,
  isOnline,
  offlineSection,
  onClose,
  onShow,
  onSelect,
  selectedItem,
  mapCenter,
  onHide,
  onFit,
}: PriwaFlightPanelProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PriwaFlightSort>("distance");
  if (!open) return null;

  const filteredItems = filterPriwaFlightItems(items, query, sort, mapCenter);
  const content = (
    <div
      ref={contentRef}
      data-testid="priwa-flight-panel-content"
      className="space-y-4"
    >
      {!isOnline && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <DisconnectOutlined className="mt-0.5 shrink-0" />
          <span>
            Ohne Netz lassen sich nur offline gespeicherte Befliegungen
            anzeigen.
          </span>
        </div>
      )}
      {selectedItem && (
        <PriwaFlightDetails
          primary={selectedItem}
          onShow={onShow}
          onFit={onFit}
          onHide={onHide}
        />
      )}
      {offlineSection}
      <section>
        <MobileMapSectionHeading>
          Alle Befliegungen{items.length > 0 ? ` (${items.length})` : ""}
        </MobileMapSectionHeading>
        <p className="-mt-1 mb-2 text-xs text-slate-500">
          Name antippen für Details und Download.
        </p>
        <div className="mb-3 flex flex-wrap gap-2">
          <Input
            allowClear
            aria-label="Befliegungen nach Name oder Datum suchen"
            placeholder="Name oder Datum suchen"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-40 flex-1"
          />
          <Select
            aria-label="Befliegungen sortieren"
            value={sort}
            onChange={setSort}
            className="min-w-44"
            options={[
              { value: "distance", label: "Nähe zur Kartenmitte" },
              { value: "date", label: "Neueste Aufnahme" },
              { value: "name", label: "Name A–Z" },
            ]}
          />
        </div>
        <PriwaFlightList
          items={filteredItems}
          selectedId={selectedItem?.mosaic.id ?? null}
          mapCenter={mapCenter}
          onSelect={(mosaicId) => {
            onSelect(mosaicId);
            contentRef.current
              ?.closest("[data-map-panel-scroll-viewport]")
              ?.scrollTo({
                top: 0,
              });
          }}
          onFit={onFit}
          isLoading={isLoading}
          onShow={onShow}
          onHide={onHide}
        />
      </section>
    </div>
  );

  if (placement === "sheet") {
    return (
      <MobileBottomSheet
        open
        title={PANEL_TITLE}
        closeLabel="Befliegungen schließen"
        onClose={onClose}
        initialSnap="expanded"
        compactRatio={0.42}
        expandedRatio={0.86}
        hideFrom="never"
        showScrollIndicator
      >
        {content}
      </MobileBottomSheet>
    );
  }

  return (
    <aside
      data-priwa-flight-panel
      data-testid="priwa-flight-panel"
      aria-label={PANEL_TITLE}
      className="priwa-flight-side-panel pointer-events-auto absolute bottom-5 left-4 z-[60] flex w-[20.5rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-xl backdrop-blur"
    >
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
        <h2 className="m-0 text-base font-semibold text-slate-950">
          {PANEL_TITLE}
        </h2>
        <Button
          shape="circle"
          icon={<CloseOutlined />}
          aria-label="Befliegungen schließen"
          onClick={onClose}
        />
      </header>
      <MapPanelScrollArea label="Befliegungen scrollen" className="px-3 py-3">
        {content}
      </MapPanelScrollArea>
    </aside>
  );
}
