import { useCallback, useRef, useState } from "react";
import Feature from "ol/Feature";
import GeoJSONFormat from "ol/format/GeoJSON";
import type Geometry from "ol/geom/Geometry";
import type VectorSource from "ol/source/Vector";

import { polygonParts } from "./aoiGeometryOperations";

export type AOIGeometry = GeoJSON.MultiPolygon | GeoJSON.Polygon;

export interface AOIDraftCheckpoint {
	geometry: AOIGeometry | null;
	history: string[];
}

interface UseAOIDraftOptions {
	getSource: () => VectorSource<Feature<Geometry>> | null;
	onChange?: (geometry: AOIGeometry | null) => void;
}

const MAX_HISTORY = 20;

const cloneGeometry = (geometry: AOIGeometry | null): AOIGeometry | null =>
	geometry ? JSON.parse(JSON.stringify(geometry)) as AOIGeometry : null;

export function useAOIDraft({ getSource, onChange }: UseAOIDraftOptions) {
	const [geometry, setGeometry] = useState<AOIGeometry | null>(null);
	const [canUndo, setCanUndo] = useState(false);
	const geometryRef = useRef<AOIGeometry | null>(null);
	const historyRef = useRef<string[]>([]);

	const publish = useCallback((nextGeometry: AOIGeometry | null) => {
		geometryRef.current = nextGeometry;
		setGeometry(nextGeometry);
		onChange?.(nextGeometry);
	}, [onChange]);

	const readSource = useCallback((): GeoJSON.MultiPolygon | null => {
		const source = getSource();
		if (!source) return null;

		const format = new GeoJSONFormat();
		const coordinates = source.getFeatures().flatMap((feature) => {
			const featureGeometry = feature.getGeometry();
			if (!featureGeometry) return [];

			return polygonParts(featureGeometry).map((polygon) => {
				const geoJsonGeometry = format.writeGeometryObject(polygon, {
					dataProjection: "EPSG:4326",
					featureProjection: "EPSG:3857",
				}) as GeoJSON.Polygon;
				return geoJsonGeometry.coordinates;
			});
		});

		return coordinates.length > 0
			? { type: "MultiPolygon", coordinates }
			: null;
	}, [getSource]);

	const replace = useCallback((nextGeometry: AOIGeometry | null) => {
		const source = getSource();
		if (!source) return;

		source.clear();
		if (nextGeometry) {
			const format = new GeoJSONFormat();
			const projectedGeometry = format.readGeometry(nextGeometry, {
				dataProjection: "EPSG:4326",
				featureProjection: "EPSG:3857",
			});
			source.addFeatures(
				polygonParts(projectedGeometry).map((polygon) => new Feature<Geometry>(polygon.clone())),
			);
		}

		publish(nextGeometry);
	}, [getSource, publish]);

	const syncFromSource = useCallback(() => {
		const nextGeometry = readSource();
		publish(nextGeometry);
		return nextGeometry;
	}, [publish, readSource]);

	const clearHistory = useCallback(() => {
		historyRef.current = [];
		setCanUndo(false);
	}, []);

	const reset = useCallback((nextGeometry: AOIGeometry | null) => {
		replace(nextGeometry);
		clearHistory();
	}, [clearHistory, replace]);

	const snapshot = useCallback(() => {
		historyRef.current.push(JSON.stringify(readSource()));
		if (historyRef.current.length > MAX_HISTORY) {
			historyRef.current.shift();
		}
		setCanUndo(true);
	}, [readSource]);

	const undo = useCallback(() => {
		const serializedGeometry = historyRef.current.pop();
		if (serializedGeometry === undefined) return false;

		replace(JSON.parse(serializedGeometry) as GeoJSON.MultiPolygon | null);
		setCanUndo(historyRef.current.length > 0);
		return true;
	}, [replace]);

	const checkpoint = useCallback((): AOIDraftCheckpoint => ({
		geometry: cloneGeometry(geometryRef.current),
		history: [...historyRef.current],
	}), []);

	const restore = useCallback((savedCheckpoint: AOIDraftCheckpoint) => {
		historyRef.current = [...savedCheckpoint.history];
		setCanUndo(historyRef.current.length > 0);
		replace(cloneGeometry(savedCheckpoint.geometry));
	}, [replace]);

	return {
		geometry,
		canUndo,
		syncFromSource,
		reset,
		snapshot,
		undo,
		checkpoint,
		restore,
	};
}
