export type PriwaFlightPanelPlacement = "sheet" | "side";

export interface IPriwaFieldLayoutInput {
  viewportWidth: number;
  viewportHeight: number;
  isCoarsePointer: boolean;
}

export interface IPriwaFieldLayout {
  /** Touch-first field layout: map-first, collapsible flight and detail sheets. */
  isFieldLayout: boolean;
  isLandscape: boolean;
  /** Where the flight list opens in the field layout. */
  flightPanelPlacement: PriwaFlightPanelPlacement;
}

/** Below Ant Design's `xl` breakpoint the three-panel review workbench no longer fits. */
export const PRIWA_DESKTOP_WORKBENCH_MIN_WIDTH = 1200;
/** Landscape viewports at least this wide keep the flight list beside the map. */
export const PRIWA_FLIGHT_SIDE_PANEL_MIN_WIDTH = 640;

export const resolvePriwaFieldLayout = ({
  viewportWidth,
  viewportHeight,
  isCoarsePointer,
}: IPriwaFieldLayoutInput): IPriwaFieldLayout => {
  const isLandscape = viewportWidth > viewportHeight;
  return {
    isFieldLayout:
      isCoarsePointer || viewportWidth < PRIWA_DESKTOP_WORKBENCH_MIN_WIDTH,
    isLandscape,
    flightPanelPlacement:
      isLandscape && viewportWidth >= PRIWA_FLIGHT_SIDE_PANEL_MIN_WIDTH
        ? "side"
        : "sheet",
  };
};
