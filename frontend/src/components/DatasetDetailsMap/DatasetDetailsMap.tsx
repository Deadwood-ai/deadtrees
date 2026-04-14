import { forwardRef, useImperativeHandle, useRef, useCallback } from "react";
import type { Map as OLMap } from "ol";
import type TileLayerWebGL from "ol/layer/WebGLTile.js";
import type VectorTileLayer from "ol/layer/VectorTile";

import { IDataset } from "../../types/dataset";
import { MapInstanceProvider, useMapInstance, useAOIEditor, AOIToolbarState } from "./hooks";
import { useDatasetAOI } from "../../hooks/useDatasetAudit";
import BaseMap from "./BaseMap";

// Re-export types for backwards compatibility
export type { AOIToolbarState } from "./hooks";

/**
 * Handle exposed to parent for map actions
 * This replaces the old forwardRef pattern - prefer using context instead
 */
export interface DatasetDetailsMapHandle {
  startDrawing: () => void;
  startEditing: () => void;
  cancelDrawing: () => void;
  cancelEditing: () => void;
  saveEditing: () => void;
  addAnotherPolygon: () => void;
  deleteAOI: () => void;
  deleteSelectedPolygon: () => void;
  refreshVectorLayers: () => void;
  zoomToExtent: (minLon: number, minLat: number, maxLon: number, maxLat: number, padding?: number) => void;
  flashLocation: (lon: number, lat: number) => void;
}

interface DatasetDetailsMapProps {
  data: IDataset;
  onMapReady?: (map: OLMap) => void;
  onOrthoLayerReady?: (layer: TileLayerWebGL) => void;
  onVectorLayersReady?: (deadwood: VectorTileLayer | null, forestCover: VectorTileLayer | null) => void;
  hideDeadwoodLayer?: boolean;
  hideForestCoverLayer?: boolean;
  hideDroneImagery?: boolean;
  refreshKey?: number;

  // Layer visibility props
  showDeadwood?: boolean;
  showForestCover?: boolean;
  showDroneImagery?: boolean;
  showAOI?: boolean;
  layerOpacity?: number;

  // Edit callbacks
  onEditDeadwood?: () => void;
  onEditForestCover?: () => void;
  isLoggedIn?: boolean;

  // AOI Editing (for audit)
  enableAOIEditing?: boolean;
  onAOIChange?: (geometry: GeoJSON.MultiPolygon | GeoJSON.Polygon | null) => void;
  onToolbarStateChange?: (state: AOIToolbarState) => void;

  // Correction Review
  canReviewCorrections?: boolean;
  onApproveCorrection?: (correctionId: number, geometryId: number) => void;
  onRevertCorrection?: (correctionId: number, geometryId: number) => void;
  allowBadQualityLayers?: boolean;
}

/**
 * Inner component that uses context for map instance
 */
const DatasetDetailsMapInner = forwardRef<DatasetDetailsMapHandle, DatasetDetailsMapProps>(
  (
    {
  data,
  onMapReady,
  onOrthoLayerReady,
  onVectorLayersReady,
  hideDeadwoodLayer = false,
  hideForestCoverLayer = false,
  hideDroneImagery = false,
  refreshKey = 0,
  showDeadwood,
  showForestCover,
  showDroneImagery,
  showAOI = true,
  layerOpacity,
  onEditDeadwood,
  onEditForestCover,
  isLoggedIn = false,
  enableAOIEditing = false,
  onAOIChange,
  onToolbarStateChange,
  canReviewCorrections = false,
  onApproveCorrection,
  onRevertCorrection,
  allowBadQualityLayers = false,
    },
    ref
  ) => {
    // Get map methods from context
    const { mapRef, refreshVectorLayers, zoomToExtent, flashLocation } = useMapInstance();
    const mapContainerRef = useRef<HTMLDivElement | null>(null);

    // Fetch AOI data for the editor
    // Note: This is also imported in BaseMap - React Query will dedupe
    const { data: aoiData } = useDatasetAOI(data?.id);

    // AOI Editor hook
    const aoiEditor = useAOIEditor({
      mapRef,
      mapContainerRef,
      enabled: enableAOIEditing,
      initialAOI: aoiData?.geometry as GeoJSON.MultiPolygon | GeoJSON.Polygon | null,
      isAOILoading: false,
      onAOIChange,
      onToolbarStateChange,
    });

    // Compute effective visibility
  const effectiveDeadwoodVisible = showDeadwood !== undefined ? showDeadwood : !hideDeadwoodLayer;
  const effectiveForestCoverVisible = showForestCover !== undefined ? showForestCover : !hideForestCoverLayer;
  const effectiveDroneImageryVisible = showDroneImagery !== undefined ? showDroneImagery : !hideDroneImagery;
  const effectiveLayerOpacity = layerOpacity ?? 1;

    // Handle popover close and refresh
    const handleApproveCorrection = useCallback((correctionId: number, geometryId: number) => {
      onApproveCorrection?.(correctionId, geometryId);
      refreshVectorLayers();
    }, [onApproveCorrection, refreshVectorLayers]);

    const handleRevertCorrection = useCallback((correctionId: number, geometryId: number) => {
      onRevertCorrection?.(correctionId, geometryId);
      refreshVectorLayers();
    }, [onRevertCorrection, refreshVectorLayers]);

    // Expose methods to parent via ref (for backwards compatibility)
  useImperativeHandle(ref, () => ({
      startDrawing: aoiEditor.startDrawing,
      startEditing: aoiEditor.startEditing,
      cancelDrawing: aoiEditor.cancelDrawing,
      cancelEditing: aoiEditor.cancelEditing,
      saveEditing: aoiEditor.saveEditing,
      addAnotherPolygon: aoiEditor.addAnotherPolygon,
      deleteAOI: aoiEditor.deleteAOI,
      deleteSelectedPolygon: aoiEditor.deleteSelectedPolygon,
    refreshVectorLayers,
    zoomToExtent,
    flashLocation,
    }), [aoiEditor, refreshVectorLayers, zoomToExtent, flashLocation]);

  return (
      <BaseMap
        data={data}
        onMapReady={onMapReady}
        onOrthoLayerReady={onOrthoLayerReady}
        onVectorLayersReady={onVectorLayersReady}
        showDeadwood={effectiveDeadwoodVisible}
        showForestCover={effectiveForestCoverVisible}
        showDroneImagery={effectiveDroneImageryVisible}
        showAOI={showAOI}
        layerOpacity={effectiveLayerOpacity}
        refreshKey={refreshKey}
        onEditDeadwood={onEditDeadwood}
        onEditForestCover={onEditForestCover}
        isLoggedIn={isLoggedIn}
        enableAOIEditing={enableAOIEditing}
        canReviewCorrections={canReviewCorrections}
        onApproveCorrection={handleApproveCorrection}
        onRevertCorrection={handleRevertCorrection}
        allowBadQualityLayers={allowBadQualityLayers}
      />
    );
  }
);

DatasetDetailsMapInner.displayName = "DatasetDetailsMapInner";

/**
 * Main DatasetDetailsMap component
 * Wraps the inner component with MapInstanceProvider
 * 
 * This is the public API - maintains backwards compatibility
 */
const DatasetDetailsMap = forwardRef<DatasetDetailsMapHandle, DatasetDetailsMapProps>(
  (props, ref) => {
    return (
      <MapInstanceProvider>
        <DatasetDetailsMapInner ref={ref} {...props} />
      </MapInstanceProvider>
    );
  }
);

DatasetDetailsMap.displayName = "DatasetDetailsMap";

export default DatasetDetailsMap;
