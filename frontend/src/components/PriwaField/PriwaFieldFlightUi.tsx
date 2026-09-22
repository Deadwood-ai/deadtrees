import PriwaFlightBar from "./PriwaFlightBar";
import PriwaFlightPanel from "./PriwaFlightPanel";
import PriwaOfflineFlightSection from "./PriwaOfflineFlightSection";
import type { PriwaFlightPanelPlacement } from "./priwaFieldLayout";
import type { PriwaFieldFlightsState } from "./usePriwaFieldFlights";
import type { PriwaOfflineMosaicsState } from "./usePriwaOfflineMosaics";

interface PriwaFieldFlightUiProps {
  flights: PriwaFieldFlightsState;
  offline: PriwaOfflineMosaicsState;
  placement: PriwaFlightPanelPlacement;
  isPanelOpen: boolean;
  isLoading: boolean;
  isOnline: boolean;
  onTogglePanel: () => void;
  onClosePanel: () => void;
  mapCenter: number[] | null;
  onFit: (mosaicId: string) => void;
}

/**
 * Field-layout flight controls: the collapsed bottom bar plus the flight
 * panel (bottom sheet or side panel) with the offline download section.
 */
export default function PriwaFieldFlightUi({
  flights,
  offline,
  placement,
  isPanelOpen,
  isLoading,
  isOnline,
  onTogglePanel,
  onClosePanel,
  mapCenter,
  onFit,
}: PriwaFieldFlightUiProps) {
  const primaryItem = flights.selectedItem;
  const isSidePanelOpen = isPanelOpen && placement === "side";

  return (
    <>
      {!isSidePanelOpen && (
        <div
          className="pointer-events-none absolute left-4 z-[55]"
          style={{
            bottom: "max(44px, calc(env(safe-area-inset-bottom, 0px) + 44px))",
          }}
        >
          <PriwaFlightBar
            primary={primaryItem?.mosaic ?? null}
            isVisible={!!primaryItem?.isVisible}
            isAvailable={!!primaryItem?.isAvailable}
            onToggleVisibility={() => {
              if (primaryItem)
                (primaryItem.isVisible
                  ? flights.hideFlight
                  : flights.showFlight)(primaryItem.mosaic.id);
            }}
            flightCount={flights.items.length}
            isLoading={isLoading}
            isOpen={isPanelOpen}
            hasOfflineCopy={!!primaryItem?.offlineEntry?.available}
            onOpen={onTogglePanel}
            onFit={() => {
              if (primaryItem) onFit(primaryItem.mosaic.id);
            }}
          />
        </div>
      )}
      <PriwaFlightPanel
        open={isPanelOpen}
        placement={placement}
        items={flights.items}
        selectedItem={primaryItem}
        mapCenter={mapCenter}
        onSelect={flights.selectFlight}
        isLoading={isLoading}
        isOnline={isOnline}
        offlineSection={
          <PriwaOfflineFlightSection
            offline={offline}
            selectedFlights={primaryItem ? [primaryItem.mosaic] : []}
            isOnline={isOnline}
            onZoomToFlight={onFit}
          />
        }
        onClose={onClosePanel}
        onShow={flights.showFlight}
        onHide={flights.hideFlight}
        onFit={onFit}
      />
    </>
  );
}
