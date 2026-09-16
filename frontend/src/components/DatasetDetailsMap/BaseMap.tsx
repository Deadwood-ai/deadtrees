import { useEffect, useRef, useCallback, useMemo } from "react";
import type VectorTileLayer from "ol/layer/VectorTile";
import { PictureOutlined } from "@ant-design/icons";

import { IDataset } from "../../types/dataset";
import { useDatasetLabelTypes } from "../../hooks/useDatasetLabelTypes";
import { useDatasetDetailsMap } from "../../hooks/useDatasetDetailsMapProvider";
import { useDatasetAOI } from "../../hooks/useDatasetAudit";
import { useIsMobile } from "../../hooks/useIsMobile";
import { hasForestCoverPredictionOutput } from "../../utils/predictionAvailability";
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

// Plain-language reason for a missing map image, derived from processing state.
function describeMissingImage(data: IDataset): { title: string; body: string } {
	if (data.has_error) {
		return {
			title: "Image could not be prepared",
			body: "Processing of this drone image ran into a problem. The dataset details are still available.",
		};
	}
	if (data.is_upload_done && !data.is_cog_done) {
		return {
			title: "Image is being prepared",
			body: "The drone image is still processing. Check back a little later.",
		};
	}
	return {
		title: "No image to show",
		body: "This dataset has no viewable drone image.",
	};
}

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
	const aoiGeometry = useMemo(() => aoiData?.geometry, [aoiData?.geometry]);

	// Core map initialization
	const {
		mapRef,
		orthoLayer,
	} = useMapCore({
		containerRef: mapContainerRef,
		cogPath: data?.cog_path,
		thumbnailPath: data?.thumbnail_path,
		// When arriving from the dataset list, ignore the persisted viewport and let
		// the map fit the new orthophoto's extent. useMapCore reads initialViewport
		// once at init, so the previous (stale) viewport would otherwise leave the
		// imagery — and any tile-search highlights — centered on the old location
		// until a full reload. (Resetting the stored viewport via an effect raced
		// the init and didn't take.)
		initialViewport: navigatedFrom === "dataset" ? { center: [0, 0], zoom: 2 } : viewport,
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
		isForestCoverDone: hasForestCoverPredictionOutput(data),
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
	if (!data.cog_path) {
		const empty = describeMissingImage(data);
		return (
			<div className="flex h-full items-center justify-center px-6 pt-24" role="status">
				<div className="flex max-w-sm flex-col items-center rounded-2xl border border-gray-200/60 bg-white/90 px-8 py-7 text-center shadow-sm backdrop-blur-sm">
					<span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-xl text-gray-400">
						<PictureOutlined />
					</span>
					<h2 className="m-0 text-base font-semibold text-gray-800">{empty.title}</h2>
					<p className="mb-0 mt-2 text-sm leading-relaxed text-gray-500">{empty.body}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="h-full w-full">
			<div
				ref={mapContainerRef}
				style={{ width: "100%", height: "100%", position: "relative" }}
				data-testid="dataset-detail-map"
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
