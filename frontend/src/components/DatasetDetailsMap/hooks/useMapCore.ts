import { useEffect, useRef, useCallback, useState } from "react";
import { Map, View, Overlay } from "ol";
import type BaseLayer from "ol/layer/Base";
import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { GeoTIFF } from "ol/source";
import type { Layer } from "ol/layer";

import { Settings } from "../../../config";
import { createStandardMapControls } from "../../../utils/basemaps";
import { createMapInteractions } from "../../../utils/mapInteractions";

export interface Viewport {
	center: number[];
	zoom: number;
	extent?: number[];
}

export interface UseMapCoreOptions {
	/** Container ref for the map */
	containerRef: React.RefObject<HTMLDivElement | null>;
	/** COG path (relative to base URL) */
	cogPath: string | null | undefined;
	/** Initial viewport state */
	initialViewport?: Viewport;
	/** Callback when viewport changes */
	onViewportChange?: (viewport: Viewport) => void;
	/** Callback when map is ready */
	onMapReady?: (map: Map) => void;
	/** Callback when ortho layer is ready */
	onOrthoLayerReady?: (layer: TileLayerWebGL) => void;
	/** Callback for the first meaningful interaction after initial map positioning */
	onFirstInteraction?: () => void;
	/** Minimum zoom level */
	minZoom?: number;
	/** Maximum zoom level */
	maxZoom?: number;
	/** Whether to wait for external dependencies before initializing */
	isReady?: boolean;
	/** Disable rotation interactions such as pinch rotate */
	disableRotation?: boolean;
}

export interface UseMapCoreReturn {
	/** Map instance ref */
	mapRef: React.MutableRefObject<Map | null>;
	/** Whether map is initialized */
	isMapReady: boolean;
	/** Ortho COG layer */
	orthoLayer: TileLayerWebGL | null;
	/** GeoTIFF extent (for fit view) */
	extent: number[] | null;
	/** Add a layer to the map */
	addLayer: (layer: Layer) => void;
	/** Remove a layer from the map */
	removeLayer: (layer: Layer) => void;
	/** Add an overlay to the map */
	addOverlay: (overlay: Overlay) => void;
	/** Remove an overlay from the map */
	removeOverlay: (overlay: Overlay) => void;
	/** Fit view to extent */
	fitToExtent: (extent?: number[]) => void;
}

type DisposableSource = {
	clear?: () => void;
	dispose?: () => void;
};

type DisposableLayer = BaseLayer & {
	getSource?: () => DisposableSource | null | undefined;
	dispose?: () => void;
};

/**
 * Core map initialization hook
 * 
 * Creates an OpenLayers map with:
 * - View derived from GeoTIFF COG extent
 * - WebGL ortho layer for drone imagery
 * - Viewport persistence
 * - Proper cleanup on unmount
 */
export function useMapCore({
	containerRef,
	cogPath,
	initialViewport,
	onViewportChange,
	onMapReady,
	onOrthoLayerReady,
	onFirstInteraction,
	minZoom = 2,
	maxZoom = 23,
	isReady = true,
	disableRotation = false,
}: UseMapCoreOptions): UseMapCoreReturn {
	const mapRef = useRef<Map | null>(null);
	const orthoLayerRef = useRef<TileLayerWebGL | null>(null);
	const [isMapReady, setIsMapReady] = useState(false);
	const [extent, setExtent] = useState<number[] | null>(null);

	// Store callbacks in refs to avoid triggering useEffect re-runs
	const onViewportChangeRef = useRef(onViewportChange);
	const onMapReadyRef = useRef(onMapReady);
	const onOrthoLayerReadyRef = useRef(onOrthoLayerReady);
	const onFirstInteractionRef = useRef(onFirstInteraction);
	const hasSeenInitialMoveEndRef = useRef(false);
	const hasTrackedInteractionRef = useRef(false);
	
	// Keep refs up to date
	useEffect(() => {
		onViewportChangeRef.current = onViewportChange;
		onMapReadyRef.current = onMapReady;
		onOrthoLayerReadyRef.current = onOrthoLayerReady;
		onFirstInteractionRef.current = onFirstInteraction;
	});

	// Layer management
	const addLayer = useCallback((layer: Layer) => {
		mapRef.current?.addLayer(layer);
	}, []);

	const removeLayer = useCallback((layer: Layer) => {
		mapRef.current?.removeLayer(layer);
	}, []);

	// Overlay management
	const addOverlay = useCallback((overlay: Overlay) => {
		mapRef.current?.addOverlay(overlay);
	}, []);

	const removeOverlay = useCallback((overlay: Overlay) => {
		mapRef.current?.removeOverlay(overlay);
	}, []);

	// Fit view to extent
	const fitToExtent = useCallback((customExtent?: number[]) => {
		const targetExtent = customExtent || extent;
		if (!mapRef.current || !targetExtent || targetExtent.length < 4) return;
		mapRef.current.getView().fit(targetExtent as [number, number, number, number]);
	}, [extent]);

	// Main map initialization
	useEffect(() => {
		// Skip if already initialized, not ready, or missing required data
		if (mapRef.current || !isReady || !cogPath || !containerRef.current) {
			return;
		}

		// Create ortho COG layer
		const orthoCogLayer = new TileLayerWebGL({
			source: new GeoTIFF({
				sources: [{
					url: Settings.COG_BASE_URL + cogPath,
					nodata: 0,
					bands: [1, 2, 3],
				}],
				convertToRGB: true,
			}),
			maxZoom: 23,
			cacheSize: 4096,
			preload: 0,
		});

		orthoLayerRef.current = orthoCogLayer;

		// Get view from GeoTIFF extent
		const orthoCogSource = orthoCogLayer.getSource();
		if (!orthoCogSource) return;

		orthoCogSource.getView().then((viewOptions) => {
			if (!viewOptions?.extent || !containerRef.current) return;

			const cogExtent = viewOptions.extent as number[];
			setExtent(cogExtent);

			// Create view with saved viewport or fit to extent
			const hasValidViewport = initialViewport && initialViewport.center[0] !== 0;
			const mapView = new View({
				center: hasValidViewport ? initialViewport.center : viewOptions.center,
				zoom: hasValidViewport && initialViewport.zoom !== 2 ? initialViewport.zoom : undefined,
				extent: cogExtent,
				minZoom,
				maxZoom,
				projection: "EPSG:3857",
				constrainOnlyCenter: true,
			});

			// Create map with only the ortho layer (others added by consuming code)
				const newMap = new Map({
					target: containerRef.current,
					layers: [orthoCogLayer],
					view: mapView,
					controls: createStandardMapControls(),
					interactions: createMapInteractions({
						doubleClickZoom: false,
						disableRotation,
					}),
				});

			// Viewport change handler - use "moveend" to only fire when movement stops
			// (using "change" fires on every frame during pan/zoom, causing excessive re-renders)
			newMap.on("moveend", () => {
				const view = newMap.getView();
				onViewportChangeRef.current?.({
					center: (view.getCenter() as number[]) || [0, 0],
					zoom: view.getZoom() || 2,
					extent: view.calculateExtent(newMap.getSize() || [0, 0]) as number[],
				});
				if (!hasSeenInitialMoveEndRef.current) {
					hasSeenInitialMoveEndRef.current = true;
					return;
				}
				if (!hasTrackedInteractionRef.current) {
					hasTrackedInteractionRef.current = true;
					onFirstInteractionRef.current?.();
				}
			});

			// Fit to extent if no saved viewport
			if (!hasValidViewport) {
				mapView.fit(cogExtent);
			}

			mapRef.current = newMap;
			setIsMapReady(true);
			onMapReadyRef.current?.(newMap);
			onOrthoLayerReadyRef.current?.(orthoCogLayer);
		}).catch((err) => {
			console.error("Failed to get GeoTIFF view:", err);
		});

		// Cleanup
		return () => {
			if (mapRef.current) {
				// Remove all layers
					mapRef.current.getLayers().forEach((layer) => {
						const disposableLayer = layer as DisposableLayer;
						const source = disposableLayer.getSource?.();
						if (source) {
							if ("clear" in source && typeof source.clear === "function") source.clear();
							if ("dispose" in source && typeof source.dispose === "function") source.dispose();
						}
						disposableLayer.dispose?.();
					});

				mapRef.current.setTarget(undefined);
				mapRef.current.dispose();
				mapRef.current = null;
				orthoLayerRef.current = null;
				hasSeenInitialMoveEndRef.current = false;
				hasTrackedInteractionRef.current = false;
				setIsMapReady(false);
				setExtent(null);
			}
		};
	// Note: callbacks are accessed via refs to avoid triggering re-runs
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isReady, cogPath, containerRef, disableRotation]);

	return {
		mapRef,
		isMapReady,
		orthoLayer: orthoLayerRef.current,
		extent,
		addLayer,
		removeLayer,
		addOverlay,
		removeOverlay,
		fitToExtent,
	};
}
