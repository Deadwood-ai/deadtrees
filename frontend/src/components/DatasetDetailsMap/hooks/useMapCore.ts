import { useEffect, useRef, useCallback, useState } from "react";
import { Map, View, Overlay } from "ol";
import type BaseLayer from "ol/layer/Base";
import ImageLayer from "ol/layer/Image";
import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { GeoTIFF } from "ol/source";
import StaticImageSource from "ol/source/ImageStatic";
import type { Layer } from "ol/layer";

import { Settings } from "../../../config";
import { createStandardMapControls } from "../../../utils/basemaps";
import { COG_SOURCE_OPTIONS } from "../../../utils/cogSourceOptions";
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
	/** Thumbnail path used as a static no-WebGL fallback */
	thumbnailPath?: string | null;
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
	orthoLayer: BaseLayer | null;
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

const disposeLayerWithSource = (layer: DisposableLayer) => {
	const source = layer.getSource?.();
	if (source) {
		if ("clear" in source && typeof source.clear === "function") source.clear();
		if ("dispose" in source && typeof source.dispose === "function") source.dispose();
	}
	layer.dispose?.();
};

const browserSupportsWebGL = () => {
	if (typeof document === "undefined") return false;

	const canvas = document.createElement("canvas");
	try {
		const context = (
			canvas.getContext("webgl2") ||
				canvas.getContext("webgl") ||
				canvas.getContext("experimental-webgl")
		) as WebGLRenderingContext | WebGL2RenderingContext | null;
		context?.getExtension("WEBGL_lose_context")?.loseContext();
		return Boolean(context);
	} catch {
		return false;
	}
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
	thumbnailPath,
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
	const orthoLayerRef = useRef<BaseLayer | null>(null);
	const [isMapReady, setIsMapReady] = useState(false);
	const [extent, setExtent] = useState<number[] | null>(null);

	// Store callbacks in refs to avoid triggering useEffect re-runs
	const onViewportChangeRef = useRef(onViewportChange);
	const onMapReadyRef = useRef(onMapReady);
	const onOrthoLayerReadyRef = useRef(onOrthoLayerReady);
	const onFirstInteractionRef = useRef(onFirstInteraction);
	const thumbnailPathRef = useRef(thumbnailPath);
	// Read via ref so a post-init change (isMobile flips false on first render)
	// configures interactions without rebuilding the whole map.
	const disableRotationRef = useRef(disableRotation);
	const hasSeenInitialMoveEndRef = useRef(false);
	const hasTrackedInteractionRef = useRef(false);

	// Keep refs up to date
	useEffect(() => {
		onViewportChangeRef.current = onViewportChange;
		onMapReadyRef.current = onMapReady;
		onOrthoLayerReadyRef.current = onOrthoLayerReady;
		onFirstInteractionRef.current = onFirstInteraction;
		thumbnailPathRef.current = thumbnailPath;
		disableRotationRef.current = disableRotation;
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

	// Latch readiness: once the map is allowed to build, keep it allowed. isReady
	// is derived from react-query loading flags; if one of those flips back to
	// loading after the map exists (e.g. a label/AOI refetch), having isReady in
	// the init effect's deps would run its cleanup — disposing and rebuilding the
	// whole map, and leaking the ortho's WebGL context each time until the context
	// is lost and rendering (including tile-search highlights) silently dies.
	const readyLatchRef = useRef(false);
	if (isReady) readyLatchRef.current = true;
	const mapEnabled = readyLatchRef.current;

	// Main map initialization
	useEffect(() => {
		// Skip if already initialized, not ready, or missing required data
		if (mapRef.current || !mapEnabled || !cogPath || !containerRef.current) {
			return;
		}

		let isDisposed = false;
		const orthoCogSource = new GeoTIFF({
			sources: [{
				url: Settings.COG_BASE_URL + cogPath,
				nodata: 0,
				bands: [1, 2, 3],
			}],
			convertToRGB: true,
			sourceOptions: COG_SOURCE_OPTIONS,
		});

		// The orthophoto COG uses OpenLayers' WebGL tile renderer. Some embedded
		// browsers disable WebGL; in that case keep the map usable with a static
		// thumbnail fallback, vector layers, AOI, and tile-search overlays.
		const supportsWebGL = browserSupportsWebGL();
		const orthoCogLayer = supportsWebGL
			? new TileLayerWebGL({
					source: orthoCogSource,
					maxZoom: 23,
					cacheSize: 4096,
					preload: 0,
				})
			: null;

		orthoLayerRef.current = orthoCogLayer;

		// Get view from GeoTIFF extent
		orthoCogSource.getView().then((viewOptions) => {
			if (isDisposed || !viewOptions?.extent || !containerRef.current) return;

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

			const fallbackThumbnailPath = thumbnailPathRef.current;
			const fallbackOrthoLayer =
				!supportsWebGL && fallbackThumbnailPath
					? new ImageLayer({
							source: new StaticImageSource({
								url: Settings.THUMBNAIL_URL + fallbackThumbnailPath,
								imageExtent: cogExtent as [number, number, number, number],
								projection: "EPSG:3857",
								crossOrigin: "anonymous",
							}),
						})
					: null;
			const displayOrthoLayer = orthoCogLayer ?? fallbackOrthoLayer;
			orthoLayerRef.current = displayOrthoLayer;

			// Create map with the COG layer when WebGL is available; otherwise the
			// georeferenced thumbnail fallback occupies the same display layer slot.
				const newMap = new Map({
					target: containerRef.current,
					layers: displayOrthoLayer ? [displayOrthoLayer] : [],
					view: mapView,
					controls: createStandardMapControls(),
					interactions: createMapInteractions({
						doubleClickZoom: false,
						disableRotation: disableRotationRef.current,
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
			if (orthoCogLayer) {
				onOrthoLayerReadyRef.current?.(orthoCogLayer);
			}
		}).catch((err) => {
			console.error("Failed to get GeoTIFF view:", err);
		});

			// Cleanup
			return () => {
				isDisposed = true;
				if (mapRef.current) {
					// Remove all layers
					mapRef.current.getLayers().forEach((layer) => {
						disposeLayerWithSource(layer as DisposableLayer);
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
				if (!mapRef.current && orthoLayerRef.current) {
					disposeLayerWithSource(orthoLayerRef.current as DisposableLayer);
					orthoLayerRef.current = null;
				}
				if (!orthoCogLayer) {
					orthoCogSource.clear();
					orthoCogSource.dispose();
				}
			};
	// Note: callbacks/disableRotation are accessed via refs to avoid triggering
	// re-runs. mapEnabled is latched (only ever false->true). The map therefore
	// rebuilds only when the dataset (cogPath) or container changes — not on the
	// transient isReady / isMobile flips that previously leaked WebGL contexts.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mapEnabled, cogPath, containerRef]);

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
