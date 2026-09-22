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
  onShow: (mosaicId: string) => void;
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
  onShow,
  onFit,
}: PriwaFieldFlightUiProps) {
  const primaryItem = flights.items.find((item) => item.isPrimary) ?? null;
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
            primary={flights.primaryFlight}
            visibleCount={flights.visibleFlights.length}
            flightCount={flights.items.length}
            isLoading={isLoading}
            isOpen={isPanelOpen}
            hasOfflineCopy={!!primaryItem?.offlineEntry?.available}
            onOpen={onTogglePanel}
            onFit={() => {
              if (flights.primaryFlight) onFit(flights.primaryFlight.id);
            }}
          />
        </div>
      )}
      <PriwaFlightPanel
        open={isPanelOpen}
        placement={placement}
        items={flights.items}
        isLoading={isLoading}
        isOnline={isOnline}
        offlineSection={
          <PriwaOfflineFlightSection
            offline={offline}
            visibleFlights={flights.visibleFlights}
            isOnline={isOnline}
            onZoomToFlight={onFit}
          />
        }
        onClose={onClosePanel}
        onShow={onShow}
        onCompare={flights.compareFlight}
        onHide={flights.hideFlight}
        onFit={onFit}
      />
    </>
  );
}
