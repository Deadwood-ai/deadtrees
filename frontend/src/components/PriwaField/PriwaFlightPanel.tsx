import { CloseOutlined, DisconnectOutlined } from "@ant-design/icons";
import { Button, Input, Select } from "antd";
import { useState } from "react";
import MapPanelScrollArea from "../MapControls/mobile/MapPanelScrollArea";

import MobileBottomSheet from "../MapControls/mobile/MobileBottomSheet";
import MobileMapSectionHeading from "../MapControls/mobile/MobileMapSectionHeading";
import PriwaFlightDownload from "./PriwaFlightDownload";
import PriwaOfflineFlightSection from "./PriwaOfflineFlightSection";
import type { PriwaOfflineMosaicsState } from "./usePriwaOfflineMosaics";
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
  offline: PriwaOfflineMosaicsState;
  onClose: () => void;
  onShow: (mosaicId: string) => void;
  onSelect: (mosaicId: string) => void;
  selectedItem: IPriwaFlightListItem | null;
  mapCenter: number[] | null;
  onHide: (mosaicId: string) => void;
  onFit: (mosaicId: string) => void;
}

const PANEL_TITLE = "Befliegungen";
const SORT_OPTIONS: {
  value: PriwaFlightSort;
  label: string;
  /** Shown in the closed select so search and sort share one line. */
  short: string;
}[] = [
  { value: "distance", label: "Nähe zur Kartenmitte", short: "Nähe" },
  { value: "date", label: "Neueste Aufnahme", short: "Neueste" },
  { value: "name", label: "Name A–Z", short: "Name" },
];

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
  offline,
  onClose,
  onShow,
  onSelect,
  selectedItem,
  mapCenter,
  onHide,
  onFit,
}: PriwaFlightPanelProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PriwaFlightSort>("distance");
  if (!open) return null;

  const filteredItems = filterPriwaFlightItems(items, query, sort, mapCenter);
  // Pinned above the scrolling list so selecting never moves the list.
  const selectedFlight = selectedItem && (
    <PriwaFlightDetails
      primary={selectedItem}
      onShow={onShow}
      onFit={onFit}
      onHide={onHide}
    >
      <PriwaFlightDownload
        key={selectedItem.mosaic.id}
        offline={offline}
        flight={selectedItem.mosaic}
        isOnline={isOnline}
      />
    </PriwaFlightDetails>
  );
  const content = (
    <div data-testid="priwa-flight-panel-content" className="space-y-2">
      {!isOnline && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <DisconnectOutlined className="mt-0.5 shrink-0" />
          <span>
            Ohne Netz lassen sich nur offline gespeicherte Befliegungen
            anzeigen.
          </span>
        </div>
      )}
      <PriwaOfflineFlightSection offline={offline} onZoomToFlight={onFit} />
      <section>
        <MobileMapSectionHeading>
          Alle Befliegungen{items.length > 0 ? ` (${items.length})` : ""}
        </MobileMapSectionHeading>
        <div className="mb-2 flex gap-2">
          <Input
            allowClear
            aria-label="Befliegungen nach Name oder Datum suchen"
            placeholder="Name oder Datum"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Select
            aria-label="Befliegungen sortieren"
            value={sort}
            onChange={setSort}
            className="w-28"
            popupMatchSelectWidth={false}
            options={SORT_OPTIONS}
            labelRender={({ value }) =>
              SORT_OPTIONS.find((option) => option.value === value)?.short
            }
          />
        </div>
        <PriwaFlightList
          items={filteredItems}
          selectedId={selectedItem?.mosaic.id ?? null}
          mapCenter={mapCenter}
          onSelect={onSelect}
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
        fixedContent={selectedFlight}
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
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 py-1.5 pl-4 pr-2">
        <h2 className="m-0 text-sm font-semibold text-slate-950">
          {PANEL_TITLE}
        </h2>
        <Button
          type="text"
          shape="circle"
          icon={<CloseOutlined />}
          aria-label="Befliegungen schließen"
          onClick={onClose}
        />
      </header>
      {selectedFlight && (
        <div className="max-h-[45%] shrink-0 overflow-y-auto px-3 pt-2">
          {selectedFlight}
        </div>
      )}
      <MapPanelScrollArea label="Befliegungen scrollen" className="px-3 py-2">
        {content}
      </MapPanelScrollArea>
    </aside>
  );
}
