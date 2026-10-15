import { useEffect, useCallback, useRef } from "react";
import type { Map as OLMap, MapBrowserEvent } from "ol";
import type VectorTileLayer from "ol/layer/VectorTile";
import type { Coordinate } from "ol/coordinate";
import type { Pixel } from "ol/pixel";

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

	// The topmost label polygon under a pixel, deadwood first. This replays the
	// rendered tile instructions at that pixel; layer.getFeatures(pixel) would
	// first draw a hit-detection image of every polygon in view.
	const featureAtPixel = useCallback((pixel: Pixel) => {
		if (!map) return null;
		const layers: [VectorTileLayer | null, "deadwood" | "forest_cover"][] = [
			[deadwoodLayer, "deadwood"],
			[forestCoverLayer, "forest_cover"],
		];
		for (const [layer, layerType] of layers) {
			if (!layer?.getVisible()) continue;
			const feature = map.forEachFeatureAtPixel(pixel, (hit) => hit, { layerFilter: (l) => l === layer });
			if (feature) return { feature, layerType };
		}
		return null;
	}, [map, deadwoodLayer, forestCoverLayer]);

	// Hover handler. Hit-testing is synchronous main-thread work, so it runs at
	// most once per animation frame and never while the map is being dragged.
	const hoverFrameRef = useRef<number | null>(null);
	const pendingHoverRef = useRef<MapBrowserEvent | null>(null);

	const detectHover = useCallback((event: MapBrowserEvent) => {
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

		const hit = featureAtPixel(map.getEventPixel(event.originalEvent));

		// Update cursor
		const targetElement = map.getTargetElement();
		if (targetElement) targetElement.style.cursor = hit ? "pointer" : "";
		isOverFeatureRef.current = !!hit;

		onHover?.(
			hit
				? {
						featureId: hit.feature.get("id"),
						layerType: hit.layerType === "deadwood" ? "Deadwood cover" : "Tree cover",
						status: hit.feature.get("correction_status") || "original",
						coordinate: event.coordinate,
					}
				: null,
		);
	}, [enabled, map, minZoom, onHover, featureAtPixel]);

	const handlePointerMove = useCallback((event: MapBrowserEvent) => {
		if (event.dragging) return;
		pendingHoverRef.current = event;
		if (hoverFrameRef.current !== null) return;
		hoverFrameRef.current = requestAnimationFrame(() => {
			hoverFrameRef.current = null;
			const latest = pendingHoverRef.current;
			pendingHoverRef.current = null;
			if (latest) detectHover(latest);
		});
	}, [detectHover]);

	// Click handler
	const handleClick = useCallback((event: MapBrowserEvent) => {
		if (!enabled || !map) {
			onClick?.(null);
			return;
		}

		const currentZoom = map.getView().getZoom();
		if (!currentZoom || currentZoom < minZoom) {
			onClick?.(null);
			return;
		}

		const hit = featureAtPixel(map.getEventPixel(event.originalEvent));
		if (!hit) {
			onClick?.(null);
			return;
		}
		const { feature, layerType } = hit;
		onClick?.({
			featureId: feature.get("id") ? Number(feature.get("id")) : 0,
			layerType,
			displayType: layerType === "deadwood" ? "Deadwood cover" : "Tree cover",
			status: feature.get("correction_status") || "original",
			correctionId: feature.get("correction_id") ? Number(feature.get("correction_id")) : undefined,
			correctionOperation: feature.get("correction_operation") || undefined,
			coordinate: event.coordinate,
		});
	}, [enabled, map, minZoom, onClick, featureAtPixel]);

	// Attach/detach event handlers
	useEffect(() => {
		if (!map || handlersAttachedRef.current) return;
		if (!deadwoodLayer && !forestCoverLayer) return;

		map.on("pointermove", handlePointerMove);
		map.on("click", handleClick);
		handlersAttachedRef.current = true;

		return () => {
			map.un("pointermove", handlePointerMove);
			map.un("click", handleClick);
			if (hoverFrameRef.current !== null) cancelAnimationFrame(hoverFrameRef.current);
			hoverFrameRef.current = null;
			pendingHoverRef.current = null;
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
