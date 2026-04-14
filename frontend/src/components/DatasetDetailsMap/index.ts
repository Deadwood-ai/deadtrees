// Main component (backwards compatible)
export { default as DatasetDetailsMap } from "./DatasetDetailsMap";
export type { DatasetDetailsMapHandle, AOIToolbarState } from "./DatasetDetailsMap";

// Core map component
export { default as BaseMap } from "./BaseMap";

// Hooks
export { MapInstanceProvider, useMapInstance, useMapInstanceOptional, useAOIEditor } from "./hooks";
export type { UseAOIEditorOptions, UseAOIEditorReturn } from "./hooks";

// Overlays
export { FeatureTooltip, FeaturePopover } from "./overlays";
export type { ClickedPolygonInfo } from "./overlays";

// Existing exports
export { default as DatasetLayerControlPanel } from "./DatasetLayerControlPanel";
export { default as DatasetInfoSidebar } from "./DatasetInfoSidebar";
export { default as EditingSidebar } from "./EditingSidebar";
export { default as DownloadSection } from "./DownloadSection";
export { default as ReportIssueModal } from "./ReportIssueModal";
export { default as DatasetNavigation } from "./DatasetNavigation";
