import { useEffect, useRef, useCallback, useMemo } from "react";
import type VectorTileLayer from "ol/layer/VectorTile";

import { IDataset } from "../../types/dataset";
import { useDatasetLabelTypes } from "../../hooks/useDatasetLabelTypes";
import { useDatasetDetailsMap } from "../../hooks/useDatasetDetailsMapProvider";
import { useDatasetAOI } from "../../hooks/useDatasetAudit";
import { useIsMobile } from "../../hooks/useIsMobile";
import { FeatureTooltip, FeaturePopover, ClickedPolygonInfo } from "./overlays";
import {
	useMapInstance,
	useMapCore,
	useBaseLayers,
	useVectorLayers,
	useAOILayers,
	useMapOverlays,
	useMapInteractions,
} from "./hooks";

interface BaseMapProps {
	data: IDataset;
	onMapReady?: (map: import("ol").Map) => void;
	onOrthoLayerReady?: (layer: import("ol/layer/WebGLTile.js").default) => void;
	onVectorLayersReady?: (deadwood: VectorTileLayer | null, forestCover: VectorTileLayer | null) => void;
	onFirstMapInteraction?: () => void;

	// Layer visibility
	showDeadwood?: boolean;
	showForestCover?: boolean;
	showDroneImagery?: boolean;
	showAOI?: boolean;
	layerOpacity?: number;
	refreshKey?: number;

	// Interaction props
	onEditDeadwood?: () => void;
	onEditForestCover?: () => void;
	isLoggedIn?: boolean;

	// AOI editing (disables static AOI layer)
	enableAOIEditing?: boolean;

	// Correction review
	canReviewCorrections?: boolean;
	onApproveCorrection?: (correctionId: number, geometryId: number) => void;
	onRevertCorrection?: (correctionId: number, geometryId: number) => void;

	// Skip interaction handlers (when editing polygon corrections)
	skipInteractions?: boolean;
	// Allow rendering predictions even when audited as poor
	allowBadQualityLayers?: boolean;
	// Override which label ID to display (for auditor model variant switching)
	deadwoodLabelIdOverride?: number | null;
	forestCoverLabelIdOverride?: number | null;
}

/**
 * Core map component - handles map initialization and layer management
 * Refactored to use composable hooks for better maintainability
 */
export default function BaseMap({
	data,
	onMapReady,
	onOrthoLayerReady,
	onVectorLayersReady,
	onFirstMapInteraction,
	showDeadwood = true,
	showForestCover = true,
	showDroneImagery = true,
	showAOI = true,
	layerOpacity = 1,
	refreshKey = 0,
	onEditDeadwood,
	onEditForestCover,
	isLoggedIn = false,
	enableAOIEditing = false,
	canReviewCorrections = false,
	onApproveCorrection,
	onRevertCorrection,
	skipInteractions = false,
	allowBadQualityLayers = false,
	deadwoodLabelIdOverride,
	forestCoverLabelIdOverride,
}: BaseMapProps) {
	// Refs
	const mapContainerRef = useRef<HTMLDivElement | null>(null);
	const tooltipRef = useRef<HTMLDivElement | null>(null);
	const popoverRef = useRef<HTMLDivElement | null>(null);

	// Context
	const { setMap, layerRefs } = useMapInstance();
	const { viewport, navigatedFrom, setViewport, layerControl } = useDatasetDetailsMap();
	const isMobile = useIsMobile();

	// Fetch label data
	const { deadwood, forestCover, isLoading: isLoadingLabels } = useDatasetLabelTypes({
		datasetId: data?.id,
		enabled: !!data?.id,
	});

	// Fetch AOI data
	const { data: aoiData, isLoading: isAOILoading } = useDatasetAOI(data?.id);
	const aoiGeometry = useMemo(() => aoiData?.geometry, [aoiData?.id]);

	// Core map initialization
	const {
		mapRef,
		orthoLayer,
	} = useMapCore({
		containerRef: mapContainerRef,
		cogPath: data?.cog_path,
		initialViewport: viewport,
		onViewportChange: setViewport,
		onMapReady: (map) => {
			setMap(map);
			onMapReady?.(map);
		},
		onOrthoLayerReady,
		onFirstInteraction: onFirstMapInteraction,
		isReady: !isLoadingLabels && !isAOILoading && !!data?.file_name,
		disableRotation: isMobile,
	});

	// Basemap layer
	useBaseLayers({
		map: mapRef.current,
		mapStyle: layerControl.mapStyle,
		showDroneImagery,
		orthoLayer,
	});

	// Memoize visibility getters to prevent unnecessary effect re-runs
	const getDeadwoodVisible = useCallback(() => showDeadwood, [showDeadwood]);
	const getForestCoverVisible = useCallback(() => showForestCover, [showForestCover]);

	// Vector layers (deadwood + forest cover)
	const {
		deadwoodLayer,
		forestCoverLayer,
		setHoveredLabelId,
		refresh: refreshVectors,
		setDeadwoodVisible,
		setForestCoverVisible,
		setLayerOpacity,
	} = useVectorLayers({
		map: mapRef.current,
		deadwoodLabelId: deadwoodLabelIdOverride !== undefined ? deadwoodLabelIdOverride : deadwood.data?.id,
		forestCoverLabelId: forestCoverLabelIdOverride !== undefined ? forestCoverLabelIdOverride : forestCover.data?.id,
		isForestCoverDone: data?.is_forest_cover_done,
		showCorrectionStyling: true,
		getDeadwoodVisible,
		getForestCoverVisible,
		opacity: layerOpacity,
		deadwoodQuality: data?.deadwood_quality,
		forestCoverQuality: data?.forest_cover_quality,
		allowBadQualityLayers,
	});

	// Store layer refs for external access
	useEffect(() => {
		if (deadwoodLayer || forestCoverLayer) {
			layerRefs.current.deadwoodVector = deadwoodLayer ?? undefined;
			layerRefs.current.forestCoverVector = forestCoverLayer ?? undefined;
			onVectorLayersReady?.(deadwoodLayer, forestCoverLayer);
		}
	}, [deadwoodLayer, forestCoverLayer, layerRefs, onVectorLayersReady]);

	// AOI layers
	useAOILayers({
		map: mapRef.current,
		geometry: aoiGeometry as GeoJSON.Polygon | GeoJSON.MultiPolygon | null,
		alwaysCreate: false,
		skipIfEditing: true,
		isEditingEnabled: enableAOIEditing,
		isVisible: showAOI,
	});

	// Overlays (tooltip + popover)
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
		enabled: !skipInteractions,
	});

	// Interactions (hover + click)
	useMapInteractions({
		map: mapRef.current,
		deadwoodLayer,
		forestCoverLayer,
		enabled: !skipInteractions,
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

	// Update visibility when props change
	useEffect(() => {
		setDeadwoodVisible(showDeadwood);
	}, [showDeadwood, setDeadwoodVisible]);

	useEffect(() => {
		setForestCoverVisible(showForestCover);
	}, [showForestCover, setForestCoverVisible]);

	useEffect(() => {
		setLayerOpacity(layerOpacity);
	}, [layerOpacity, setLayerOpacity]);

	// Refresh layers when key changes
	useEffect(() => {
		if (refreshKey > 0) {
			refreshVectors();
		}
	}, [refreshKey, refreshVectors]);

	// Reset viewport when navigated from dataset
	useEffect(() => {
		if (navigatedFrom === "dataset") {
			setViewport({ center: [0, 0], zoom: 2 });
		}
	}, [navigatedFrom, setViewport]);

	// Edit handler
	const handleEdit = useCallback(() => {
		hidePopover();
		if (popoverInfo?.layerType === "deadwood") {
			onEditDeadwood?.();
		} else {
			onEditForestCover?.();
		}
	}, [popoverInfo, onEditDeadwood, onEditForestCover, hidePopover]);

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
					isLoggedIn={isLoggedIn}
					isVisible={!popoverInfo && !!tooltipContent}
				/>

				{/* Popover overlay */}
				<FeaturePopover
					ref={popoverRef}
					info={popoverInfo as ClickedPolygonInfo | null}
					isVisible={!!popoverInfo}
					isLoggedIn={isLoggedIn}
					canReviewCorrections={canReviewCorrections}
					onClose={hidePopover}
					onEdit={handleEdit}
					onApproveCorrection={onApproveCorrection}
					onRevertCorrection={onRevertCorrection}
				/>
			</div>
		</div>
	);
}
