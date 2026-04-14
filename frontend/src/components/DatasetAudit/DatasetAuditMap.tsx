import { useEffect, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from "react";
import type { Map } from "ol";
import type TileLayerWebGL from "ol/layer/WebGLTile.js";

import { IDataset } from "../../types/dataset";
import { useDatasetLabelTypes } from "../../hooks/useDatasetLabelTypes";
import { useDatasetDetailsMap } from "../../hooks/useDatasetDetailsMapProvider";
import { useDatasetAOI } from "../../hooks/useDatasetAudit";
import { FeatureTooltip, FeaturePopover, ClickedPolygonInfo } from "../DatasetDetailsMap/overlays";
import {
	useMapCore,
	useBaseLayers,
	useVectorLayers,
	useAOILayers,
	useMapOverlays,
	useMapInteractions,
	useMapUtilities,
	useAOIEditor,
	AOIToolbarState,
} from "../DatasetDetailsMap/hooks";

interface DatasetAuditMapProps {
	data: IDataset;
	onMapReady?: (map: Map) => void;
	onOrthoLayerReady?: (layer: TileLayerWebGL) => void;

	// Editing state - controls which layers to show
	isEditing?: boolean;
	editingLayerType?: "deadwood" | "forest_cover" | null;

	// AOI editing
	enableAOIEditing?: boolean;
	onAOIChange?: (geometry: GeoJSON.MultiPolygon | GeoJSON.Polygon | null) => void;
	onToolbarStateChange?: (state: AOIToolbarState) => void;

	// Correction review
	canReviewCorrections?: boolean;
	onApproveCorrection?: (correctionId: number, geometryId: number) => void;
	onRevertCorrection?: (correctionId: number, geometryId: number) => void;

	// Edit triggers
	onEditDeadwood?: () => void;
	onEditForestCover?: () => void;

	// Refresh trigger
	refreshKey?: number;
}

export interface DatasetAuditMapHandle {
	// Map utilities
	refreshVectorLayers: () => void;
	zoomToExtent: (minLon: number, minLat: number, maxLon: number, maxLat: number, padding?: number) => void;
	flashLocation: (lon: number, lat: number) => void;
	getMap: () => Map | null;

	// AOI editing methods
	startDrawing: () => void;
	cancelDrawing: () => void;
	startEditing: () => void;
	saveEditing: () => void;
	cancelEditing: () => void;
	addAnotherPolygon: () => void;
	deleteAOI: () => void;
	deleteSelectedPolygon: () => void;
}

/**
 * Dedicated map component for the audit page
 * 
 * Key differences from DatasetDetailsMap/BaseMap:
 * 1. AOI always visible (alwaysCreate: true)
 * 2. Layer visibility synced with context on init
 * 3. When editing, hides MVT layers (only editing overlay visible)
 * 4. Built-in correction review support
 * 5. Integrated AOI editing support
 * 
 * Uses the same shared hooks as BaseMap for code reuse.
 */
const DatasetAuditMap = forwardRef<DatasetAuditMapHandle, DatasetAuditMapProps>(({
	data,
	onMapReady,
	onOrthoLayerReady,
	isEditing = false,
	editingLayerType: _editingLayerType = null,
	enableAOIEditing = false,
	onAOIChange,
	onToolbarStateChange,
	canReviewCorrections = false,
	onApproveCorrection,
	onRevertCorrection,
	onEditDeadwood,
	onEditForestCover,
	refreshKey = 0,
}, ref) => {
	// Refs
	const mapContainerRef = useRef<HTMLDivElement | null>(null);
	const tooltipRef = useRef<HTMLDivElement | null>(null);
	const popoverRef = useRef<HTMLDivElement | null>(null);

	// Context - USE THIS FOR INITIAL VISIBILITY
	const { viewport, setViewport, layerControl } = useDatasetDetailsMap();

	// Fetch label data
	const { deadwood, forestCover, isLoading: isLoadingLabels } = useDatasetLabelTypes({
		datasetId: data?.id,
		enabled: !!data?.id,
	});

	// Fetch AOI data
	const { data: aoiData, isLoading: isAOILoading } = useDatasetAOI(data?.id);
	const aoiGeometry = useMemo(() => aoiData?.geometry, [aoiData?.id]);

	// Compute effective visibility - HIDE MVT LAYERS WHEN EDITING
	const effectiveDeadwoodVisible = useMemo(() => {
		if (isEditing) return false; // Hide when editing so only editing overlay is visible
		return layerControl.showDeadwood;
	}, [isEditing, layerControl.showDeadwood]);

	const effectiveForestCoverVisible = useMemo(() => {
		if (isEditing) return false;
		return layerControl.showForestCover;
	}, [isEditing, layerControl.showForestCover]);

	// Core map initialization
	const {
		mapRef,
		isMapReady,
		orthoLayer,
	} = useMapCore({
		containerRef: mapContainerRef,
		cogPath: data?.cog_path,
		initialViewport: viewport,
		onViewportChange: setViewport,
		onMapReady,
		onOrthoLayerReady,
		minZoom: 2,
		isReady: !isLoadingLabels && !isAOILoading && !!data?.file_name,
	});

	// Basemap layer
	useBaseLayers({
		map: mapRef.current,
		mapStyle: layerControl.mapStyle,
		showDroneImagery: layerControl.showDroneImagery,
		orthoLayer,
	});

	// Memoize visibility getters to prevent unnecessary effect re-runs
	const getDeadwoodVisible = useCallback(() => effectiveDeadwoodVisible, [effectiveDeadwoodVisible]);
	const getForestCoverVisible = useCallback(() => effectiveForestCoverVisible, [effectiveForestCoverVisible]);

	// Vector layers - visibility controlled by editing state
	// Use filterCorrectionStatus: 'all' to show deleted polygons for auditors
	const {
		deadwoodLayer,
		forestCoverLayer,
		setHoveredLabelId,
		refresh: refreshVectors,
	} = useVectorLayers({
		map: mapRef.current,
		deadwoodLabelId: deadwood.data?.id,
		forestCoverLabelId: forestCover.data?.id,
		isForestCoverDone: data?.is_forest_cover_done,
		showCorrectionStyling: true,
		filterCorrectionStatus: 'all', // Show all polygons including pending deletions
		getDeadwoodVisible,
		getForestCoverVisible,
		opacity: layerControl.layerOpacity,
	});

	// Update layer visibility when effective visibility changes
	useEffect(() => {
		deadwoodLayer?.setVisible(effectiveDeadwoodVisible);
		deadwoodLayer?.setOpacity(layerControl.layerOpacity);
	}, [deadwoodLayer, effectiveDeadwoodVisible, layerControl.layerOpacity]);

	useEffect(() => {
		forestCoverLayer?.setVisible(effectiveForestCoverVisible);
		forestCoverLayer?.setOpacity(layerControl.layerOpacity);
	}, [forestCoverLayer, effectiveForestCoverVisible, layerControl.layerOpacity]);

	// AOI layers - ALWAYS CREATE for audit page
	useAOILayers({
		map: mapRef.current,
		geometry: aoiGeometry as GeoJSON.Polygon | GeoJSON.MultiPolygon | null,
		alwaysCreate: true, // Key difference from BaseMap
		skipIfEditing: false,
		isEditingEnabled: enableAOIEditing,
		isVisible: layerControl.showAOI,
	});

	// AOI Editor hook
	const aoiEditor = useAOIEditor({
		mapRef,
		mapContainerRef,
		enabled: enableAOIEditing && isMapReady && !isEditing,
		initialAOI: aoiGeometry as GeoJSON.MultiPolygon | GeoJSON.Polygon | null,
		isAOILoading,
		onAOIChange,
		onToolbarStateChange,
	});

	// Overlays - disabled when polygon editing OR AOI drawing/editing
	const isAOIActive = aoiEditor.isDrawing || aoiEditor.isEditing;
	const {
		tooltipContent,
		popoverInfo,
		showTooltip,
		hideTooltip,
		showPopover,
		hidePopover,
	} = useMapOverlays({
		map: mapRef.current,
		tooltipRef,
		popoverRef,
		enabled: !isEditing && !isAOIActive,
	});

	// Interactions - disabled when polygon editing OR AOI drawing/editing
	useMapInteractions({
		map: mapRef.current,
		deadwoodLayer,
		forestCoverLayer,
		enabled: !isEditing && !isAOIActive,
		onHover: (info) => {
			if (info) {
				setHoveredLabelId(info.featureId);
				showTooltip({ type: info.layerType, status: info.status }, info.coordinate);
			} else {
				setHoveredLabelId(null);
				hideTooltip();
			}
		},
		onClick: (info) => {
			if (info) {
				showPopover({
					type: info.displayType,
					status: info.status,
					layerType: info.layerType,
					correctionId: info.correctionId,
					geometryId: info.featureId,
					correctionOperation: info.correctionOperation,
				}, info.coordinate);
			} else {
				hidePopover();
			}
		},
	});

	// Map utilities
	const { zoomToExtent, flashLocation, getMap } = useMapUtilities({ mapRef });

	// Close popover when editing starts
	useEffect(() => {
		if (isEditing) {
			hidePopover();
		}
	}, [isEditing, hidePopover]);

	// Refresh layers when key changes
	useEffect(() => {
		if (refreshKey > 0) {
			refreshVectors();
		}
	}, [refreshKey, refreshVectors]);

	// Edit handler
	const handleEdit = useCallback(() => {
		hidePopover();
		if (popoverInfo?.layerType === "deadwood") {
			onEditDeadwood?.();
		} else {
			onEditForestCover?.();
		}
	}, [popoverInfo, onEditDeadwood, onEditForestCover, hidePopover]);

	// Expose methods via useImperativeHandle
	useImperativeHandle(ref, () => ({
		// Map utilities
		refreshVectorLayers: refreshVectors,
		zoomToExtent,
		flashLocation,
		getMap,

		// AOI editing methods - delegate to aoiEditor
		startDrawing: () => aoiEditor.startDrawing(),
		cancelDrawing: () => aoiEditor.cancelDrawing(),
		startEditing: () => aoiEditor.startEditing(),
		saveEditing: () => aoiEditor.saveEditing(),
		cancelEditing: () => aoiEditor.cancelEditing(),
		addAnotherPolygon: () => aoiEditor.addAnotherPolygon(),
		deleteAOI: () => aoiEditor.deleteAOI(),
		deleteSelectedPolygon: () => aoiEditor.deleteSelectedPolygon(),
	}), [refreshVectors, zoomToExtent, flashLocation, getMap, aoiEditor]);

	if (!data) return null;

	return (
		<div className="h-full w-full">
			<div
				ref={mapContainerRef}
				style={{ width: "100%", height: "100%", position: "relative" }}
				data-rr-ignore
			>
				{/* Tooltip overlay */}
				<FeatureTooltip
					ref={tooltipRef}
					content={tooltipContent}
					isLoggedIn={true}
					isVisible={!isEditing && !isAOIActive && !popoverInfo && !!tooltipContent}
				/>

				{/* Popover overlay */}
				<FeaturePopover
					ref={popoverRef}
					info={popoverInfo as ClickedPolygonInfo | null}
					isVisible={!isEditing && !isAOIActive && !!popoverInfo}
					isLoggedIn={true}
					canReviewCorrections={canReviewCorrections}
					onClose={hidePopover}
					onEdit={handleEdit}
					onApproveCorrection={onApproveCorrection}
					onRevertCorrection={onRevertCorrection}
				/>
			</div>
		</div>
	);
});

DatasetAuditMap.displayName = "DatasetAuditMap";

export default DatasetAuditMap;
export type { AOIToolbarState };
