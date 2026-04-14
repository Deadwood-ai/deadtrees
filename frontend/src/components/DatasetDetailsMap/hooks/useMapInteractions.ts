import { useEffect, useCallback, useRef } from "react";
import type { Map as OLMap, MapBrowserEvent } from "ol";
import type VectorTileLayer from "ol/layer/VectorTile";
import type { Coordinate } from "ol/coordinate";

export interface HoverInfo {
	featureId: number;
	layerType: string;
	status: string;
	coordinate: Coordinate;
}

export interface ClickInfo {
	featureId: number;
	layerType: "deadwood" | "forest_cover";
	displayType: string;
	status: string;
	correctionId?: number;
	correctionOperation?: string;
	coordinate: Coordinate;
}

export interface UseMapInteractionsOptions {
	/** Map instance */
	map: OLMap | null;
	/** Deadwood vector layer */
	deadwoodLayer: VectorTileLayer | null;
	/** Forest cover vector layer */
	forestCoverLayer: VectorTileLayer | null;
	/** Whether interactions are enabled (disabled during editing) */
	enabled?: boolean;
	/** Minimum zoom level for interactions */
	minZoom?: number;
	/** Callback for hover events */
	onHover?: (info: HoverInfo | null) => void;
	/** Callback for click events */
	onClick?: (info: ClickInfo | null) => void;
}

export interface UseMapInteractionsReturn {
	/** Whether pointer is currently over a feature */
	isOverFeature: boolean;
}

/**
 * Hook for managing map interactions (hover and click on features)
 * 
 * Handles:
 * - Feature hover detection with layer identification
 * - Feature click detection with correction info extraction
 * - Cursor style management
 * - Zoom-based interaction enable/disable
 */
export function useMapInteractions({
	map,
	deadwoodLayer,
	forestCoverLayer,
	enabled = true,
	minZoom = 16,
	onHover,
	onClick,
}: UseMapInteractionsOptions): UseMapInteractionsReturn {
	const isOverFeatureRef = useRef(false);
	const handlersAttachedRef = useRef(false);

	// Hover handler
	const handlePointerMove = useCallback((event: MapBrowserEvent<PointerEvent>) => {
		if (!enabled || !map) {
			// Reset cursor when disabled
			const targetElement = map?.getTargetElement();
			if (targetElement) targetElement.style.cursor = "";
			onHover?.(null);
			return;
		}

		const currentZoom = map.getView().getZoom();
		if (!currentZoom || currentZoom < minZoom) {
			const targetElement = map.getTargetElement();
			if (targetElement) targetElement.style.cursor = "";
			isOverFeatureRef.current = false;
			onHover?.(null);
			return;
		}

		const pixel = map.getEventPixel(event.originalEvent);
		let hitLayer: VectorTileLayer | null = null;
		let layerType = "";

		// Check deadwood layer first (higher priority)
		if (deadwoodLayer?.getVisible() && map.hasFeatureAtPixel(pixel, { layerFilter: (l) => l === deadwoodLayer })) {
			hitLayer = deadwoodLayer;
			layerType = "Deadwood";
		} else if (forestCoverLayer?.getVisible() && map.hasFeatureAtPixel(pixel, { layerFilter: (l) => l === forestCoverLayer })) {
			hitLayer = forestCoverLayer;
			layerType = "Forest Cover";
		}

		// Update cursor
		const targetElement = map.getTargetElement();
		if (targetElement) targetElement.style.cursor = hitLayer ? "pointer" : "";
		isOverFeatureRef.current = !!hitLayer;

		if (hitLayer) {
			hitLayer.getFeatures(pixel).then((features) => {
				if (features.length > 0) {
					const feature = features[0];
					onHover?.({
						featureId: feature.get("id"),
						layerType,
						status: feature.get("correction_status") || "original",
						coordinate: event.coordinate,
					});
				} else {
					onHover?.(null);
				}
			});
		} else {
			onHover?.(null);
		}
	}, [enabled, map, deadwoodLayer, forestCoverLayer, minZoom, onHover]);

	// Click handler
	const handleClick = useCallback((event: MapBrowserEvent<PointerEvent>) => {
		if (!enabled || !map) {
			onClick?.(null);
			return;
		}

		const currentZoom = map.getView().getZoom();
		if (!currentZoom || currentZoom < minZoom) {
			onClick?.(null);
			return;
		}

		const pixel = map.getEventPixel(event.originalEvent);
		let hitLayer: VectorTileLayer | null = null;
		let layerType: "deadwood" | "forest_cover" = "deadwood";
		let displayType = "";

		if (deadwoodLayer?.getVisible() && map.hasFeatureAtPixel(pixel, { layerFilter: (l) => l === deadwoodLayer })) {
			hitLayer = deadwoodLayer;
			layerType = "deadwood";
			displayType = "Deadwood";
		} else if (forestCoverLayer?.getVisible() && map.hasFeatureAtPixel(pixel, { layerFilter: (l) => l === forestCoverLayer })) {
			hitLayer = forestCoverLayer;
			layerType = "forest_cover";
			displayType = "Forest Cover";
		}

		if (hitLayer) {
			hitLayer.getFeatures(pixel).then((features) => {
				if (features.length > 0) {
					const feature = features[0];
					onClick?.({
						featureId: feature.get("id") ? Number(feature.get("id")) : 0,
						layerType,
						displayType,
						status: feature.get("correction_status") || "original",
						correctionId: feature.get("correction_id") ? Number(feature.get("correction_id")) : undefined,
						correctionOperation: feature.get("correction_operation") || undefined,
						coordinate: event.coordinate,
					});
				} else {
					onClick?.(null);
				}
			});
		} else {
			onClick?.(null);
		}
	}, [enabled, map, deadwoodLayer, forestCoverLayer, minZoom, onClick]);

	// Attach/detach event handlers
	useEffect(() => {
		if (!map || handlersAttachedRef.current) return;
		if (!deadwoodLayer && !forestCoverLayer) return;

		map.on("pointermove", handlePointerMove as any);
		map.on("click", handleClick as any);
		handlersAttachedRef.current = true;

		return () => {
			map.un("pointermove", handlePointerMove as any);
			map.un("click", handleClick as any);
			handlersAttachedRef.current = false;
		};
	}, [map, deadwoodLayer, forestCoverLayer, handlePointerMove, handleClick]);

	// Reset cursor when interactions are disabled
	useEffect(() => {
		if (!enabled && map) {
			const targetElement = map.getTargetElement();
			if (targetElement) targetElement.style.cursor = "";
		}
	}, [enabled, map]);

	return {
		isOverFeature: isOverFeatureRef.current,
	};
}
