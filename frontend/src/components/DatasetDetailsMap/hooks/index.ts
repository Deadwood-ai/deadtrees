// Context providers
export { MapInstanceProvider, useMapInstance, useMapInstanceOptional } from "./useMapInstance";

// Core hooks
export { useMapCore } from "./useMapCore";
export type { Viewport, UseMapCoreOptions, UseMapCoreReturn } from "./useMapCore";

// Layer hooks
export { useBaseLayers } from "./useBaseLayers";
export type { MapStyle, UseBaseLayersOptions, UseBaseLayersReturn } from "./useBaseLayers";

export { useVectorLayers } from "./useVectorLayers";
export type { UseVectorLayersOptions, UseVectorLayersReturn } from "./useVectorLayers";

export { useAOILayers } from "./useAOILayers";
export type { UseAOILayersOptions, UseAOILayersReturn } from "./useAOILayers";

// Interaction hooks
export { useMapOverlays } from "./useMapOverlays";
export type { TooltipContent, PopoverInfo, UseMapOverlaysOptions, UseMapOverlaysReturn } from "./useMapOverlays";

export { useMapInteractions } from "./useMapInteractions";
export type { HoverInfo, ClickInfo, UseMapInteractionsOptions, UseMapInteractionsReturn } from "./useMapInteractions";

// Utility hooks
export { useMapUtilities } from "./useMapUtilities";
export type { UseMapUtilitiesOptions, UseMapUtilitiesReturn } from "./useMapUtilities";

// AOI editing
export { useAOIEditor } from "./useAOIEditor";
export type { AOIToolbarState, UseAOIEditorOptions, UseAOIEditorReturn } from "./useAOIEditor";
