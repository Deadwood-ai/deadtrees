import { useRef, forwardRef, useImperativeHandle, useCallback, useState } from "react";
import type { Map as OLMap } from "ol";
import type TileLayerWebGL from "ol/layer/WebGLTile.js";

import { IDataset } from "../../types/dataset";
import DatasetAuditMap, { DatasetAuditMapHandle } from "./DatasetAuditMap";
import { AOIToolbarState } from "../DatasetDetailsMap/hooks/useAOIEditor";
import DatasetLayerControlPanel from "../DatasetDetailsMap/DatasetLayerControlPanel";
import { useDatasetDetailsMap } from "../../hooks/useDatasetDetailsMapProvider";
import { useDatasetLabelTypes } from "../../hooks/useDatasetLabelTypes";
import { MAP_FLOATING_TOP_CLASS } from "../../theme/mapLayout";
import { hasForestCoverPredictionOutput } from "../../utils/predictionAvailability";
import AuditCheckMap, { type IAuditCheckMapProps } from "./checks/AuditCheckMap";

interface AuditMapWithControlsProps {
	dataset: IDataset;
	onAOIChange: (geometry: GeoJSON.MultiPolygon | GeoJSON.Polygon | null) => void;
	onToolbarStateChange: (state: AOIToolbarState) => void;
	/** the open audit section's map mode */
	checkMap: IAuditCheckMapProps;
}

export interface AuditMapWithControlsHandle {
	// Map utilities
	refreshVectorLayers: () => void;
	zoomToExtent: (minLon: number, minLat: number, maxLon: number, maxLat: number, padding?: number) => void;
	flashLocation: (lon: number, lat: number) => void;

	// AOI editing methods
	startDrawing: () => void;
	cancelDrawing: () => void;
	startEditing: () => void;
	saveEditing: () => void;
	cancelEditing: () => void;
	addAnotherPolygon: () => void;
	deleteAOI: () => void;
	deleteSelectedPolygon: () => void;
	mergeSelectedPolygons: () => void;
	clipSelectedPolygons: () => void;
	cutSelectedPolygon: () => void;
	undoAOIChange: () => void;
}

/**
 * The audit detail view's map: the layers and their controls, the AOI editor and the open step's
 * check. Suggested edits and editing the predictions live on the Edits & flags page.
 */
const AuditMapWithControls = forwardRef<AuditMapWithControlsHandle, AuditMapWithControlsProps>(
	({ dataset, onAOIChange, onToolbarStateChange, checkMap }, ref) => {
		const mapRef = useRef<DatasetAuditMapHandle>(null);

		// Get layer control state from context
		const {
			layerControl,
			setMapStyle,
			setShowForestCover,
			setShowDeadwood,
			setShowDroneImagery,
			setShowAOI,
			setLayerOpacity,
		} = useDatasetDetailsMap();

		// Check if labels exist
		const { deadwood, forestCover } = useDatasetLabelTypes({
			datasetId: dataset?.id,
			enabled: !!dataset?.id,
		});

		const hasDeadwood = !!deadwood.data?.id;
		const hasForestCover = !!forestCover.data?.id && hasForestCoverPredictionOutput(dataset);

		// Expose methods to parent - delegate to mapRef
		useImperativeHandle(ref, () => ({
			// Map utilities
			refreshVectorLayers: () => mapRef.current?.refreshVectorLayers(),
			zoomToExtent: (minLon: number, minLat: number, maxLon: number, maxLat: number, padding?: number) =>
				mapRef.current?.zoomToExtent(minLon, minLat, maxLon, maxLat, padding),
			flashLocation: (lon: number, lat: number) => mapRef.current?.flashLocation(lon, lat),

			// AOI editing methods
			startDrawing: () => mapRef.current?.startDrawing(),
			cancelDrawing: () => mapRef.current?.cancelDrawing(),
			startEditing: () => mapRef.current?.startEditing(),
			saveEditing: () => mapRef.current?.saveEditing(),
			cancelEditing: () => mapRef.current?.cancelEditing(),
			addAnotherPolygon: () => mapRef.current?.addAnotherPolygon(),
			deleteAOI: () => mapRef.current?.deleteAOI(),
			deleteSelectedPolygon: () => mapRef.current?.deleteSelectedPolygon(),
			mergeSelectedPolygons: () => mapRef.current?.mergeSelectedPolygons(),
			clipSelectedPolygons: () => mapRef.current?.clipSelectedPolygons(),
			cutSelectedPolygon: () => mapRef.current?.cutSelectedPolygon(),
			undoAOIChange: () => mapRef.current?.undoAOIChange(),
		}), []);

		// The OpenLayers map and drone layer for the check modes; the state only signals readiness.
		const olMapRef = useRef<OLMap | null>(null);
		const orthoLayerRef = useRef<TileLayerWebGL | null>(null);
		const [checkLayersReady, setCheckLayersReady] = useState(0);

		const handleMapReady = useCallback((map: OLMap) => {
			olMapRef.current = map;
			setCheckLayersReady((n) => n + 1);
		}, []);

		const handleOrthoLayerReady = useCallback((layer: TileLayerWebGL) => {
			orthoLayerRef.current = layer;
			setCheckLayersReady((n) => n + 1);
		}, []);

		return (
			<div className="relative h-full w-full flex-1">
				<div className={`absolute right-4 ${MAP_FLOATING_TOP_CLASS} z-50 pointer-events-auto`}>
					<DatasetLayerControlPanel
						mapStyle={layerControl.mapStyle}
						onMapStyleChange={setMapStyle}
						showForestCover={layerControl.showForestCover}
						setShowForestCover={setShowForestCover}
						showDeadwood={layerControl.showDeadwood}
						setShowDeadwood={setShowDeadwood}
						showDroneImagery={layerControl.showDroneImagery}
						setShowDroneImagery={setShowDroneImagery}
						showAOI={layerControl.showAOI}
						setShowAOI={setShowAOI}
						hasForestCover={hasForestCover}
						hasDeadwood={hasDeadwood}
						hasAOI={true}
						opacity={layerControl.layerOpacity}
						setOpacity={setLayerOpacity}
						isLoggedIn={true}
					/>
				</div>

				{/* The open section's check on the map */}
				{checkLayersReady > 0 && (
					<AuditCheckMap key={`${dataset.id}:${checkMap.section?.id ?? "none"}`} map={olMapRef.current} orthoLayer={orthoLayerRef.current} {...checkMap} />
				)}

				<DatasetAuditMap
					ref={mapRef}
					data={dataset}
					onMapReady={handleMapReady}
					onOrthoLayerReady={handleOrthoLayerReady}
					enableAOIEditing
					onAOIChange={onAOIChange}
					onToolbarStateChange={onToolbarStateChange}
				/>
			</div>
		);
	}
);

AuditMapWithControls.displayName = "AuditMapWithControls";

export default AuditMapWithControls;
export type { AOIToolbarState };
