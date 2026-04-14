import { useEffect, useRef, useCallback } from "react";
import type { Map as OLMap } from "ol";
import type VectorLayer from "ol/layer/Vector";
import type VectorSource from "ol/source/Vector";

import { createAOIVectorLayer, createAOIMaskLayer } from "../createVectorLayer";

export interface UseAOILayersOptions {
	/** Map instance */
	map: OLMap | null;
	/** AOI geometry */
	geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null | undefined;
	/** Whether to always create AOI layers (audit mode) or only when not editing */
	alwaysCreate?: boolean;
	/** Skip creation if AOI editing is enabled (editing creates its own layer) */
	skipIfEditing?: boolean;
	/** Whether AOI editing is currently enabled */
	isEditingEnabled?: boolean;
	/** Whether AOI is visible */
	isVisible?: boolean;
}

export interface UseAOILayersReturn {
	/** AOI vector layer (outline) */
	aoiLayer: VectorLayer<VectorSource> | null;
	/** AOI mask layer (darkens outside area) */
	maskLayer: VectorLayer<VectorSource> | null;
	/** Set AOI visibility */
	setVisible: (visible: boolean) => void;
}

/**
 * Hook for managing AOI display layers
 * 
 * Creates and manages:
 * - AOI vector layer (blue outline)
 * - AOI mask layer (darkens area outside AOI)
 * - Visibility controls
 * 
 * Supports two modes:
 * - Default: Skips creation when editing is enabled (for DatasetDetailsMap)
 * - Always create: Creates layers regardless of editing (for DatasetAuditMap)
 */
export function useAOILayers({
	map,
	geometry,
	alwaysCreate = false,
	skipIfEditing = true,
	isEditingEnabled = false,
	isVisible = true,
}: UseAOILayersOptions): UseAOILayersReturn {
	const aoiLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
	const maskLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
	const isInitializedRef = useRef(false);

	// Determine if we should create the layers
	const shouldCreate = geometry && (alwaysCreate || !skipIfEditing || !isEditingEnabled);

	// Create layers when map and geometry are available
	useEffect(() => {
		if (!map || isInitializedRef.current) return;
		if (!shouldCreate || !geometry) return;

		// Create AOI layers
		const aoiLayer = createAOIVectorLayer(geometry);
		const maskLayer = createAOIMaskLayer(geometry);

		// Set initial visibility
		aoiLayer.setVisible(isVisible);
		maskLayer.setVisible(isVisible);

		// Add to map (mask first so it's below outline)
		map.addLayer(maskLayer);
		map.addLayer(aoiLayer);

		aoiLayerRef.current = aoiLayer;
		maskLayerRef.current = maskLayer;
		isInitializedRef.current = true;

		// Cleanup
		return () => {
			if (map) {
				if (aoiLayerRef.current) {
					map.removeLayer(aoiLayerRef.current);
					const source = aoiLayerRef.current.getSource();
					if (source) source.clear();
					aoiLayerRef.current = null;
				}
				if (maskLayerRef.current) {
					map.removeLayer(maskLayerRef.current);
					const source = maskLayerRef.current.getSource();
					if (source) source.clear();
					maskLayerRef.current = null;
				}
			}
			isInitializedRef.current = false;
		};
	}, [map, geometry, shouldCreate, isVisible]);

	// Update visibility
	useEffect(() => {
		aoiLayerRef.current?.setVisible(isVisible);
		maskLayerRef.current?.setVisible(isVisible);
	}, [isVisible]);

	// Visibility setter
	const setVisible = useCallback((visible: boolean) => {
		aoiLayerRef.current?.setVisible(visible);
		maskLayerRef.current?.setVisible(visible);
	}, []);

	return {
		aoiLayer: aoiLayerRef.current,
		maskLayer: maskLayerRef.current,
		setVisible,
	};
}
