import { useEffect, useRef, useCallback } from "react";
import type BaseLayer from "ol/layer/Base";
import LayerGroup from "ol/layer/Group";
import TileLayer from "ol/layer/Tile";
import { XYZ } from "ol/source";
import type { Map as OLMap } from "ol";
import type TileLayerWebGL from "ol/layer/WebGLTile.js";

import {
	createOpenFreeMapLibertyLayerGroup,
	createWaybackTileLayer,
	createWaybackSource,
} from "../../../utils/basemaps";

// Latest Wayback release for satellite imagery
const DEFAULT_WAYBACK_RELEASE = 31144;

export type MapStyle = string;

export interface UseBaseLayersOptions {
	/** Map instance */
	map: OLMap | null;
	/** Map style - determines basemap source (satellite-streets-v12 or streets) */
	mapStyle: string;
	/** Whether drone imagery (ortho) is visible */
	showDroneImagery?: boolean;
	/** Ortho layer ref (from useMapCore) */
	orthoLayer?: TileLayerWebGL | null;
}

export interface UseBaseLayersReturn {
	/** Basemap layer */
	basemapLayer: BaseLayer | null;
	/** Set basemap visibility */
	setBasemapVisible: (visible: boolean) => void;
	/** Set drone imagery visibility */
	setDroneImageryVisible: (visible: boolean) => void;
}

const disposeSource = (source: unknown) => {
	if (
		source &&
		typeof source === "object" &&
		"dispose" in source &&
		typeof source.dispose === "function"
	) {
		source.dispose();
	}
};

/**
 * Hook for managing base layers (basemap + ortho)
 * 
 * Creates and manages:
 * - Basemap tile layer (satellite wayback or OSM)
 * - Ortho COG visibility
 */
export function useBaseLayers({
	map,
	mapStyle,
	showDroneImagery = true,
	orthoLayer,
}: UseBaseLayersOptions): UseBaseLayersReturn {
	const basemapLayerRef = useRef<BaseLayer | null>(null);
	const libertyLayerRef = useRef<LayerGroup | null>(null);
	const waybackLayerRef = useRef<TileLayer<XYZ> | null>(null);
	const isInitializedRef = useRef(false);

	// Create basemap when map is ready
	useEffect(() => {
		if (!map || isInitializedRef.current) return;

		const isSatellite = mapStyle === "satellite-streets-v12";
		const libertyLayer = createOpenFreeMapLibertyLayerGroup();
		libertyLayer.setVisible(!isSatellite);

		const waybackLayer = createWaybackTileLayer(DEFAULT_WAYBACK_RELEASE);
		waybackLayer.setVisible(isSatellite);

		// Insert at bottom so basemaps sit below ortho
		map.getLayers().insertAt(0, libertyLayer);
		map.getLayers().insertAt(1, waybackLayer);
		libertyLayerRef.current = libertyLayer;
		waybackLayerRef.current = waybackLayer;
		basemapLayerRef.current = isSatellite ? waybackLayer : libertyLayer;
		isInitializedRef.current = true;

		// Cleanup
		return () => {
			if (map) {
				if (libertyLayerRef.current) {
					map.removeLayer(libertyLayerRef.current);
					libertyLayerRef.current = null;
				}
				if (waybackLayerRef.current) {
					map.removeLayer(waybackLayerRef.current);
					disposeSource(waybackLayerRef.current.getSource());
					waybackLayerRef.current = null;
				}
				basemapLayerRef.current = null;
			}
			isInitializedRef.current = false;
		};
	}, [map, mapStyle]);

	// Update basemap visibility when style changes
	useEffect(() => {
		if (!libertyLayerRef.current || !waybackLayerRef.current) return;

		const isSatellite = mapStyle === "satellite-streets-v12";
		libertyLayerRef.current.setVisible(!isSatellite);
		waybackLayerRef.current.setVisible(isSatellite);
		waybackLayerRef.current.setSource(createWaybackSource(DEFAULT_WAYBACK_RELEASE));
		basemapLayerRef.current = isSatellite ? waybackLayerRef.current : libertyLayerRef.current;
	}, [mapStyle]);

	// Update ortho visibility
	useEffect(() => {
		if (orthoLayer) {
			orthoLayer.setVisible(showDroneImagery);
		}
	}, [orthoLayer, showDroneImagery]);

	// Visibility setters
	const setBasemapVisible = useCallback((visible: boolean) => {
		libertyLayerRef.current?.setVisible(visible && mapStyle !== "satellite-streets-v12");
		waybackLayerRef.current?.setVisible(visible && mapStyle === "satellite-streets-v12");
	}, [mapStyle]);

	const setDroneImageryVisible = useCallback((visible: boolean) => {
		orthoLayer?.setVisible(visible);
	}, [orthoLayer]);

	return {
		basemapLayer: basemapLayerRef.current,
		setBasemapVisible,
		setDroneImageryVisible,
	};
}
