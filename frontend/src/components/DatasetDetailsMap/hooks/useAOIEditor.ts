import { useState, useRef, useCallback, useEffect } from "react";
import { message } from "antd";
import type { Map as OLMap } from "ol";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Draw, Modify, Select } from "ol/interaction";
import { Style, Fill, Stroke, Circle as CircleStyle } from "ol/style";
import { click } from "ol/events/condition";
import { Polygon, MultiPolygon } from "ol/geom";
import Feature from "ol/Feature";
import type { Geometry } from "ol/geom";
import GeoJSON from "ol/format/GeoJSON";
import type { FeatureLike } from "ol/Feature";
import { palette } from "../../../theme/palette";
import { mapColors } from "../../../theme/mapColors";

export interface AOIToolbarState {
	isDrawing: boolean;
	isEditing: boolean;
	hasAOI: boolean;
	isAOILoading: boolean;
	selectedFeatureForEdit: boolean;
	polygonCount: number;
}

export interface UseAOIEditorOptions {
	mapRef: React.MutableRefObject<OLMap | null>;
	mapContainerRef: React.MutableRefObject<HTMLDivElement | null>;
	enabled: boolean;
	initialAOI?: GeoJSON.MultiPolygon | GeoJSON.Polygon | null;
	isAOILoading?: boolean;
	onAOIChange?: (geometry: GeoJSON.MultiPolygon | GeoJSON.Polygon | null) => void;
	onToolbarStateChange?: (state: AOIToolbarState) => void;
}

export interface UseAOIEditorReturn {
	// State
	isDrawing: boolean;
	isEditing: boolean;
	hasAOI: boolean;
	selectedFeatureForEdit: FeatureLike | null;

	// Actions
	startDrawing: () => void;
	cancelDrawing: () => void;
	startEditing: () => void;
	saveEditing: () => void;
	cancelEditing: () => void;
	addAnotherPolygon: () => void;
	deleteAOI: () => void;
	deleteSelectedPolygon: () => void;

	// Layer
	editableAOILayer: VectorLayer<VectorSource> | null;
}

/**
 * Hook for AOI (Area of Interest) drawing and editing
 * Extracted from DatasetDetailsMap to improve maintainability
 */
export function useAOIEditor({
	mapRef,
	mapContainerRef,
	enabled,
	initialAOI,
	isAOILoading = false,
	onAOIChange,
	onToolbarStateChange,
}: UseAOIEditorOptions): UseAOIEditorReturn {
	// State
	const [isDrawing, setIsDrawing] = useState(false);
	const [isEditing, setIsEditing] = useState(false);
	const [hasAOI, setHasAOI] = useState(false);
	const [selectedFeatureForEdit, setSelectedFeatureForEdit] = useState<FeatureLike | null>(null);
	const [showEditableLayer, setShowEditableLayer] = useState(false);

	// Refs
	const editableAOILayerRef = useRef<VectorLayer<VectorSource> | null>(null);
	const drawInteractionRef = useRef<Draw | null>(null);
	const modifyInteractionRef = useRef<Modify | null>(null);
	const selectInteractionRef = useRef<Select | null>(null);
	const currentAOIRef = useRef<GeoJSON.MultiPolygon | GeoJSON.Polygon | null>(null);

	// Helper: Get current geometry from editable AOI layer
	const getCurrentGeometry = useCallback((): GeoJSON.MultiPolygon | GeoJSON.Polygon | null => {
		if (!editableAOILayerRef.current) return null;
		const source = editableAOILayerRef.current.getSource();
		if (!source) return null;

		const features = source.getFeatures();
		if (features.length === 0) return null;

		const format = new GeoJSON();

		if (features.length === 1) {
			const feature = features[0];
			const geometry = feature.getGeometry();

			if (geometry instanceof Polygon) {
				const geoJsonGeometry = format.writeGeometryObject(geometry, {
					dataProjection: "EPSG:4326",
					featureProjection: "EPSG:3857",
				}) as GeoJSON.Polygon;

				return {
					type: "MultiPolygon",
					coordinates: [geoJsonGeometry.coordinates],
				};
			} else if (geometry instanceof MultiPolygon) {
				return format.writeGeometryObject(geometry, {
					dataProjection: "EPSG:4326",
					featureProjection: "EPSG:3857",
				}) as GeoJSON.MultiPolygon;
			}
		} else if (features.length > 1) {
			const polygonCoordinates: number[][][][] = [];

			features.forEach((feature) => {
				const geometry = feature.getGeometry();
				if (geometry instanceof Polygon) {
					const geoJsonGeometry = format.writeGeometryObject(geometry, {
						dataProjection: "EPSG:4326",
						featureProjection: "EPSG:3857",
					}) as GeoJSON.Polygon;
					polygonCoordinates.push(geoJsonGeometry.coordinates);
				}
			});

			if (polygonCoordinates.length > 0) {
				return {
					type: "MultiPolygon",
					coordinates: polygonCoordinates,
				};
			}
		}

		return null;
	}, []);

	// Helper: Update AOI state and notify parent
	const updateAOIWithGeometry = useCallback((geometry: GeoJSON.MultiPolygon | GeoJSON.Polygon | null) => {
		currentAOIRef.current = geometry;
		setHasAOI(!!geometry);
		onAOIChange?.(geometry);
	}, [onAOIChange]);

	// Helper: Clear all interactions
	const clearInteractions = useCallback(() => {
		if (mapRef.current) {
			if (drawInteractionRef.current) {
				mapRef.current.removeInteraction(drawInteractionRef.current);
				drawInteractionRef.current = null;
			}
			if (selectInteractionRef.current) {
				mapRef.current.removeInteraction(selectInteractionRef.current);
				selectInteractionRef.current = null;
			}
			if (modifyInteractionRef.current) {
				mapRef.current.removeInteraction(modifyInteractionRef.current);
				modifyInteractionRef.current = null;
			}
		}

		if (mapContainerRef.current) {
			mapContainerRef.current.style.cursor = "";
		}
	}, [mapRef, mapContainerRef]);

	// Keep editable AOI layer hidden unless the AOI editor is actively being used.
	const setEditableLayerVisibility = useCallback((visible: boolean) => {
		editableAOILayerRef.current?.setVisible(visible);
	}, []);

	// Start drawing a new polygon
	const startDrawing = useCallback(() => {
		if (!enabled) return;
		clearInteractions();
		if (!mapRef.current || !editableAOILayerRef.current) return;
		setEditableLayerVisibility(true);
		const source = editableAOILayerRef.current.getSource();
		if (!source) return;

		const draw = new Draw({
			source: source,
			type: "Polygon",
			style: new Style({
				stroke: new Stroke({
					color: mapColors.aoi.stroke,
					width: 2,
					lineDash: [5, 5],
				}),
				fill: new Fill({
					color: mapColors.aoi.fill,
				}),
			}),
		});

		draw.on("drawend", () => {
			setTimeout(() => {
				clearInteractions();
				setIsDrawing(false);
				setShowEditableLayer(true);
				const currentGeometry = getCurrentGeometry();
				updateAOIWithGeometry(currentGeometry);
				message.success("Polygon drawn successfully.");
			}, 10);
		});

		mapRef.current.addInteraction(draw);
		drawInteractionRef.current = draw;
		setIsDrawing(true);
		setIsEditing(false);

		if (mapContainerRef.current) {
			mapContainerRef.current.style.cursor = "crosshair";
		}
	}, [enabled, mapRef, mapContainerRef, clearInteractions, getCurrentGeometry, updateAOIWithGeometry, setEditableLayerVisibility]);

	// Add another polygon
	const addAnotherPolygon = useCallback(() => startDrawing(), [startDrawing]);

	// Cancel drawing
	const cancelDrawing = useCallback(() => {
		clearInteractions();
		setIsDrawing(false);
		setShowEditableLayer(false);
		message.info("Drawing cancelled");
	}, [clearInteractions]);

	// Setup editing interactions
	const setupEditingInteractions = useCallback(() => {
		if (!mapRef.current || !editableAOILayerRef.current) return false;
		const source = editableAOILayerRef.current.getSource();
		if (!source || source.getFeatures().length === 0) {
			console.warn("setupEditingInteractions: No features in source to edit.");
			return false;
		}

		clearInteractions();

		const select = new Select({
			condition: click,
			layers: [editableAOILayerRef.current],
			style: new Style({
				stroke: new Stroke({ color: palette.state.hover, width: 3 }),
				fill: new Fill({ color: "rgba(0, 255, 255, 0.1)" }),
			}),
		});

		select.on("select", (event) => {
			const selectedFeatures = event.target.getFeatures();
			if (selectedFeatures.getLength() > 0) {
				setSelectedFeatureForEdit(selectedFeatures.item(0));
			} else {
				setSelectedFeatureForEdit(null);
			}
		});

		const modify = new Modify({
			features: select.getFeatures(),
			style: new Style({
				image: new CircleStyle({
					radius: 5,
					fill: new Fill({ color: palette.state.hover }),
					stroke: new Stroke({ color: "white", width: 1 }),
				}),
			}),
		});

		modify.on("modifyend", () => {
			const currentGeometry = getCurrentGeometry();
			if (currentGeometry) {
				updateAOIWithGeometry(currentGeometry);
			}
		});

		mapRef.current.addInteraction(select);
		mapRef.current.addInteraction(modify);
		selectInteractionRef.current = select;
		modifyInteractionRef.current = modify;
		return true;
	}, [mapRef, clearInteractions, getCurrentGeometry, updateAOIWithGeometry]);

	// Start editing existing AOI
	const startEditing = useCallback(() => {
		if (!enabled) return;
		if (!hasAOI) {
			message.error("No AOI to edit.");
			return;
		}
		setEditableLayerVisibility(true);
		setIsDrawing(false);
		setSelectedFeatureForEdit(null);
		if (setupEditingInteractions()) {
			setIsEditing(true);
			message.info("Click on a polygon to select and edit it.");

			if (mapContainerRef.current) {
				mapContainerRef.current.style.cursor = "pointer";
			}
		} else {
			message.error("Could not start editing. AOI feature might be missing.");
		}
	}, [enabled, hasAOI, mapContainerRef, setupEditingInteractions, setEditableLayerVisibility]);

	// Save editing
	const saveEditing = useCallback(() => {
		clearInteractions();
		setIsEditing(false);
		setSelectedFeatureForEdit(null);
		setShowEditableLayer(true);
		message.success("AOI edits applied. Save audit to persist.");
	}, [clearInteractions]);

	// Cancel editing (restore original)
	const cancelEditing = useCallback(() => {
		clearInteractions();
		setIsEditing(false);
		setShowEditableLayer(false);
		setSelectedFeatureForEdit(null);

		// Reload original AOI if available
		if (initialAOI && editableAOILayerRef.current) {
			const source = editableAOILayerRef.current.getSource();
			source?.clear();

			try {
				const format = new GeoJSON();
				const loadedGeometry = initialAOI;

				if (loadedGeometry.type === "MultiPolygon") {
					loadedGeometry.coordinates.forEach((polygonCoords) => {
						const polygonGeometry: GeoJSON.Polygon = {
							type: "Polygon",
							coordinates: polygonCoords,
						};

						const features = format.readFeatures(polygonGeometry, {
							dataProjection: "EPSG:4326",
							featureProjection: "EPSG:3857",
						});

						features.forEach(f => {
							if (f && f.getGeometry()) {
								source?.addFeature(f);
							}
						});
					});
				} else if (loadedGeometry.type === "Polygon") {
					const features = format.readFeatures(loadedGeometry, {
						dataProjection: "EPSG:4326",
						featureProjection: "EPSG:3857",
					});

					features.forEach(f => {
						if (f && f.getGeometry()) {
							source?.addFeature(f);
						}
					});
				}

				updateAOIWithGeometry(initialAOI);
			} catch (error) {
				console.error("Error restoring AOI after cancel:", error);
			}
		}

		message.info("Editing cancelled.");
	}, [clearInteractions, initialAOI, updateAOIWithGeometry]);

	// Delete selected polygon
	const deleteSelectedPolygon = useCallback(() => {
		if (!selectedFeatureForEdit || !editableAOILayerRef.current) {
			message.error("No polygon selected for deletion.");
			return;
		}

		const source = editableAOILayerRef.current.getSource();
		if (!source) return;

		source.removeFeature(selectedFeatureForEdit as Feature<Geometry>);
		setSelectedFeatureForEdit(null);

		const currentGeometry = getCurrentGeometry();
		updateAOIWithGeometry(currentGeometry);

		if (currentGeometry) {
			message.success("Selected polygon deleted.");
		} else {
			setIsEditing(false);
			setShowEditableLayer(false);
			clearInteractions();
			message.success("Last polygon deleted. Exiting edit mode.");
		}
	}, [selectedFeatureForEdit, getCurrentGeometry, updateAOIWithGeometry, clearInteractions]);

	// Delete entire AOI
	const deleteAOI = useCallback(() => {
		if (!enabled) return;
		clearInteractions();
		const source = editableAOILayerRef.current?.getSource();
		source?.clear();
		updateAOIWithGeometry(null);
		setIsEditing(false);
		setIsDrawing(false);
		setShowEditableLayer(false);
		message.success("AOI deleted.");
	}, [enabled, clearInteractions, updateAOIWithGeometry]);

	// Initialize editable AOI layer when enabled and map is ready
	useEffect(() => {
		if (!enabled || !mapRef.current) return;

		// Create editable AOI layer if not already created
		if (!editableAOILayerRef.current) {
			const editableAOISource = new VectorSource();
			const editableAOILayer = new VectorLayer({
				source: editableAOISource,
				style: new Style({
					stroke: new Stroke({
						color: mapColors.aoi.stroke,
						width: 3,
					}),
					fill: new Fill({
						color: mapColors.aoi.fill,
					}),
				}),
				zIndex: 100,
			});
			editableAOILayer.setVisible(false);

			mapRef.current.addLayer(editableAOILayer);
			editableAOILayerRef.current = editableAOILayer;

			// Load existing AOI if available
			if (initialAOI) {
				try {
					const format = new GeoJSON();
					const loadedGeometry = initialAOI;

					if (loadedGeometry.type === "MultiPolygon") {
						loadedGeometry.coordinates.forEach((polygonCoords) => {
							const polygonGeometry: GeoJSON.Polygon = {
								type: "Polygon",
								coordinates: polygonCoords,
							};

							const features = format.readFeatures(polygonGeometry, {
								dataProjection: "EPSG:4326",
								featureProjection: "EPSG:3857",
							});

							features.forEach(f => {
								if (f && f.getGeometry()) {
									editableAOISource.addFeature(f);
								}
							});
						});
					} else if (loadedGeometry.type === "Polygon") {
						const features = format.readFeatures(loadedGeometry, {
							dataProjection: "EPSG:4326",
							featureProjection: "EPSG:3857",
						});

						features.forEach(f => {
							if (f && f.getGeometry()) {
								editableAOISource.addFeature(f);
							}
						});
					}

					currentAOIRef.current = loadedGeometry;
					setHasAOI(true);
					onAOIChange?.(loadedGeometry);
				} catch (error) {
					console.error("Error loading existing AOI for editing:", error);
				}
			}
		}

		return () => {
			clearInteractions();
		};
	}, [enabled, mapRef, initialAOI, onAOIChange, clearInteractions]);

	// Ensure visibility tracks AOI editing mode only.
	useEffect(() => {
		if (!enabled) {
			setEditableLayerVisibility(false);
			return;
		}
		setEditableLayerVisibility(isDrawing || isEditing || showEditableLayer);
	}, [enabled, isDrawing, isEditing, showEditableLayer, setEditableLayerVisibility]);

	// Report state changes to parent
	useEffect(() => {
		if (!enabled || !onToolbarStateChange) return;

		const polygonCount = currentAOIRef.current?.type === "MultiPolygon"
			? currentAOIRef.current.coordinates.length
			: currentAOIRef.current?.type === "Polygon" ? 1 : 0;

		onToolbarStateChange({
			isDrawing,
			isEditing,
			hasAOI,
			isAOILoading,
			selectedFeatureForEdit: !!selectedFeatureForEdit,
			polygonCount,
		});
	}, [enabled, isDrawing, isEditing, hasAOI, isAOILoading, selectedFeatureForEdit, onToolbarStateChange]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			clearInteractions();
		};
	}, [clearInteractions]);

	return {
		isDrawing,
		isEditing,
		hasAOI,
		selectedFeatureForEdit,
		startDrawing,
		cancelDrawing,
		startEditing,
		saveEditing,
		cancelEditing,
		addAnotherPolygon,
		deleteAOI,
		deleteSelectedPolygon,
		editableAOILayer: editableAOILayerRef.current,
	};
}
