import { useEffect, useRef, useCallback } from "react";
import type { Map as OLMap } from "ol";
import type VectorTileLayer from "ol/layer/VectorTile";
import { Style, Stroke } from "ol/style";
import type { FeatureLike } from "ol/Feature";
import { palette } from "../../../theme/palette";

import { createDeadwoodVectorLayer, createForestCoverVectorLayer } from "../createVectorLayer";

export interface UseVectorLayersOptions {
	/** Map instance */
	map: OLMap | null;
	/** Deadwood label ID */
	deadwoodLabelId?: number | null;
	/** Forest cover label ID */
	forestCoverLabelId?: number | null;
	/** Whether forest cover is done processing */
	isForestCoverDone?: boolean;
	/** Enable correction styling (color-coded by status) */
	showCorrectionStyling?: boolean;
	/** Filter by correction status: 'all' shows everything including deleted, 'pending' shows only pending */
	filterCorrectionStatus?: string | null;
	/** Visibility control function - called to get current visibility state */
	getDeadwoodVisible?: () => boolean;
	/** Visibility control function */
	getForestCoverVisible?: () => boolean;
	/** Layer opacity */
	opacity?: number;
	/** Quality flags for conditional rendering */
	deadwoodQuality?: boolean | string | null;
	forestCoverQuality?: boolean | string | null;
	/** Allow rendering layers even when quality is marked as bad */
	allowBadQualityLayers?: boolean;
}

export interface UseVectorLayersReturn {
	/** Deadwood MVT layer */
	deadwoodLayer: VectorTileLayer | null;
	/** Forest cover MVT layer */
	forestCoverLayer: VectorTileLayer | null;
	/** Selection layer for hover effects */
	selectionLayer: VectorTileLayer | null;
	/** Currently hovered label ID */
	hoveredLabelId: number | null;
	/** Set hovered label ID (for external control) */
	setHoveredLabelId: (id: number | null) => void;
	/** Refresh all vector layers */
	refresh: () => void;
	/** Set deadwood visibility */
	setDeadwoodVisible: (visible: boolean) => void;
	/** Set forest cover visibility */
	setForestCoverVisible: (visible: boolean) => void;
	/** Set layer opacity */
	setLayerOpacity: (opacity: number) => void;
}

/**
 * Hook for managing vector tile layers (deadwood + forest cover)
 * 
 * Creates and manages:
 * - Deadwood MVT layer with correction styling
 * - Forest cover MVT layer with correction styling
 * - Selection layer for hover highlighting
 * - Visibility and opacity controls
 */
export function useVectorLayers({
	map,
	deadwoodLabelId,
	forestCoverLabelId,
	isForestCoverDone = false,
	showCorrectionStyling = true,
	filterCorrectionStatus,
	getDeadwoodVisible,
	getForestCoverVisible,
	opacity = 1,
	deadwoodQuality,
	forestCoverQuality,
	allowBadQualityLayers = false,
}: UseVectorLayersOptions): UseVectorLayersReturn {
	const deadwoodLayerRef = useRef<VectorTileLayer | null>(null);
	const forestCoverLayerRef = useRef<VectorTileLayer | null>(null);
	const selectionLayerRef = useRef<VectorTileLayer | null>(null);
	const hoveredLabelIdRef = useRef<number | null>(null);
	const isInitializedRef = useRef(false);

	// Check quality flags
	const allowDeadwood = (() => {
		if (allowBadQualityLayers) return true;
		if (deadwoodQuality === undefined || deadwoodQuality === null) return true;
		if (typeof deadwoodQuality === "boolean") return deadwoodQuality;
		if (typeof deadwoodQuality === "string") return deadwoodQuality !== "bad";
		return true;
	})();

	const allowForestCover = (() => {
		if (allowBadQualityLayers) return true;
		if (forestCoverQuality === undefined || forestCoverQuality === null) return true;
		if (typeof forestCoverQuality === "boolean") return forestCoverQuality;
		if (typeof forestCoverQuality === "string") return forestCoverQuality !== "bad";
		return true;
	})();

	// Set hovered label ID (triggers style update)
	const setHoveredLabelId = useCallback((id: number | null) => {
		hoveredLabelIdRef.current = id;
		// Force style update on selection layer
		if (selectionLayerRef.current) {
			selectionLayerRef.current.changed();
		}
	}, []);

	// Create layers when map and label IDs are available
	useEffect(() => {
		if (!map || isInitializedRef.current) return;

		// Create deadwood layer
		if (deadwoodLabelId && allowDeadwood) {
			const deadwoodLayer = createDeadwoodVectorLayer(deadwoodLabelId, { 
				showCorrectionStyling,
				filterCorrectionStatus,
			});
			deadwoodLayer.setZIndex(13);
			map.addLayer(deadwoodLayer);
			deadwoodLayerRef.current = deadwoodLayer;

			// Create selection layer for hover (shares source with deadwood)
			const selectionLayer = new (deadwoodLayer.constructor as any)({
				source: deadwoodLayer.getSource()!,
				style: (feature: FeatureLike) => {
					if (hoveredLabelIdRef.current !== null && feature.get("id") === hoveredLabelIdRef.current) {
						return new Style({
							stroke: new Stroke({ color: palette.state.hover, width: 3 }),
						});
					}
					return undefined;
				},
				renderMode: "vector",
				renderBuffer: 512,
			});
			selectionLayer.setZIndex(14);
			map.addLayer(selectionLayer);
			selectionLayerRef.current = selectionLayer;
		}

		// Create forest cover layer
		if (forestCoverLabelId && isForestCoverDone && allowForestCover) {
			const forestCoverLayer = createForestCoverVectorLayer(forestCoverLabelId, { 
				showCorrectionStyling,
				filterCorrectionStatus,
			});
			forestCoverLayer.setZIndex(12);
			map.addLayer(forestCoverLayer);
			forestCoverLayerRef.current = forestCoverLayer;
		}

		isInitializedRef.current = true;

		// Set initial visibility
		if (getDeadwoodVisible && deadwoodLayerRef.current) {
			deadwoodLayerRef.current.setVisible(getDeadwoodVisible());
		}
		if (getForestCoverVisible && forestCoverLayerRef.current) {
			forestCoverLayerRef.current.setVisible(getForestCoverVisible());
		}

		// Cleanup
		return () => {
			if (map) {
				if (deadwoodLayerRef.current) {
					map.removeLayer(deadwoodLayerRef.current);
					const source = deadwoodLayerRef.current.getSource();
					if (source && "dispose" in source) (source as any).dispose();
					deadwoodLayerRef.current = null;
				}
				if (forestCoverLayerRef.current) {
					map.removeLayer(forestCoverLayerRef.current);
					const source = forestCoverLayerRef.current.getSource();
					if (source && "dispose" in source) (source as any).dispose();
					forestCoverLayerRef.current = null;
				}
				if (selectionLayerRef.current) {
					map.removeLayer(selectionLayerRef.current);
					selectionLayerRef.current = null;
				}
			}
			isInitializedRef.current = false;
		};
	// Note: getDeadwoodVisible/getForestCoverVisible intentionally excluded from deps
	// They're only used for initial visibility - updates handled by separate effects below
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [map, deadwoodLabelId, forestCoverLabelId, isForestCoverDone, showCorrectionStyling, filterCorrectionStatus, allowDeadwood, allowForestCover]);

	// Visibility controls
	const setDeadwoodVisible = useCallback((visible: boolean) => {
		deadwoodLayerRef.current?.setVisible(visible);
	}, []);

	const setForestCoverVisible = useCallback((visible: boolean) => {
		forestCoverLayerRef.current?.setVisible(visible);
	}, []);

	const setLayerOpacity = useCallback((newOpacity: number) => {
		deadwoodLayerRef.current?.setOpacity(newOpacity);
		forestCoverLayerRef.current?.setOpacity(newOpacity);
	}, []);

	// Update visibility when control functions return different values
	useEffect(() => {
		if (getDeadwoodVisible && deadwoodLayerRef.current) {
			deadwoodLayerRef.current.setVisible(getDeadwoodVisible());
		}
	}, [getDeadwoodVisible]);

	useEffect(() => {
		if (getForestCoverVisible && forestCoverLayerRef.current) {
			forestCoverLayerRef.current.setVisible(getForestCoverVisible());
		}
	}, [getForestCoverVisible]);

	// Update opacity
	useEffect(() => {
		deadwoodLayerRef.current?.setOpacity(opacity);
		forestCoverLayerRef.current?.setOpacity(opacity);
	}, [opacity]);

	// Refresh layers - clear cache first to force immediate reload
	const refresh = useCallback(() => {
		const deadwoodSource = deadwoodLayerRef.current?.getSource();
		const forestCoverSource = forestCoverLayerRef.current?.getSource();

		// Clear tile cache before refresh to prevent stale tiles showing
		// alongside new data (fixes "dual layer" issue after edits)
		if (deadwoodSource) {
			deadwoodSource.clear();
			deadwoodSource.refresh();
		}
		if (forestCoverSource) {
			forestCoverSource.clear();
			forestCoverSource.refresh();
		}
	}, []);

	return {
		deadwoodLayer: deadwoodLayerRef.current,
		forestCoverLayer: forestCoverLayerRef.current,
		selectionLayer: selectionLayerRef.current,
		hoveredLabelId: hoveredLabelIdRef.current,
		setHoveredLabelId,
		refresh,
		setDeadwoodVisible,
		setForestCoverVisible,
		setLayerOpacity,
	};
}
