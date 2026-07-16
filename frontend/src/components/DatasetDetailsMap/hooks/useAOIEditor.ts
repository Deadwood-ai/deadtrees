import { useCallback, useEffect, useRef, useState } from "react";
import { message } from "antd";
import type { Map as OLMap } from "ol";
import Feature from "ol/Feature";
import type Geometry from "ol/geom/Geometry";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Draw, Modify, Select } from "ol/interaction";
import { click, shiftKeyOnly } from "ol/events/condition";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";

import { mapColors } from "../../../theme/mapColors";
import { palette } from "../../../theme/palette";
import {
	clipAOIGeometries,
	cutAOIGeometry,
	mergeAOIGeometries,
	polygonParts,
} from "./aoiGeometryOperations";
import {
	type AOIDraftCheckpoint,
	type AOIGeometry,
	useAOIDraft,
} from "./useAOIDraft";

type AOIEditorMode = "idle" | "drawing" | "editing" | "cutting";
export type AOIDrawingMode = "add" | "cut" | null;

export interface AOIToolbarState {
	isDrawing: boolean;
	drawingMode: AOIDrawingMode;
	isEditing: boolean;
	hasAOI: boolean;
	isAOILoading: boolean;
	selectionCount: number;
	polygonCount: number;
	canUndo: boolean;
}

export interface UseAOIEditorOptions {
	mapRef: React.MutableRefObject<OLMap | null>;
	mapContainerRef: React.MutableRefObject<HTMLDivElement | null>;
	enabled: boolean;
	initialAOI?: AOIGeometry | null;
	isAOILoading?: boolean;
	onAOIChange?: (geometry: AOIGeometry | null) => void;
	onToolbarStateChange?: (state: AOIToolbarState) => void;
}

export interface UseAOIEditorReturn {
	isDrawing: boolean;
	drawingMode: AOIDrawingMode;
	isEditing: boolean;
	hasAOI: boolean;
	selectionCount: number;
	canUndo: boolean;
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
	undo: () => void;
	editableAOILayer: VectorLayer<VectorSource<Feature<Geometry>>> | null;
}

export function useAOIEditor({
	mapRef,
	mapContainerRef,
	enabled,
	initialAOI,
	isAOILoading = false,
	onAOIChange,
	onToolbarStateChange,
}: UseAOIEditorOptions): UseAOIEditorReturn {
	const [mode, setMode] = useState<AOIEditorMode>("idle");
	const [selectionCount, setSelectionCount] = useState(0);
	const [showEditableLayer, setShowEditableLayer] = useState(false);

	const editableAOILayerRef = useRef<VectorLayer<VectorSource<Feature<Geometry>>> | null>(null);
	const drawInteractionRef = useRef<Draw | null>(null);
	const modifyInteractionRef = useRef<Modify | null>(null);
	const selectInteractionRef = useRef<Select | null>(null);
	const editCheckpointRef = useRef<AOIDraftCheckpoint | null>(null);
	const lastInitialAOIRef = useRef<string | null>(null);

	const isDrawing = mode === "drawing" || mode === "cutting";
	const isEditing = mode === "editing" || mode === "cutting";
	const drawingMode: AOIDrawingMode = mode === "drawing"
		? "add"
		: mode === "cutting" ? "cut" : null;

	const getSource = useCallback(
		() => editableAOILayerRef.current?.getSource() ?? null,
		[],
	);
	const {
		geometry,
		canUndo,
		syncFromSource,
		reset,
		repopulateSource,
		snapshot,
		undo: undoDraft,
		checkpoint,
		restore,
	} = useAOIDraft({ getSource, onChange: onAOIChange });
	const hasAOI = !!geometry;

	const clearSelection = useCallback(() => {
		selectInteractionRef.current?.getFeatures().clear();
		setSelectionCount(0);
	}, []);

	const syncSelection = useCallback(() => {
		const selection = selectInteractionRef.current?.getFeatures();
		if (!selection) {
			setSelectionCount(0);
			return;
		}

		while (selection.getLength() > 2) {
			selection.removeAt(0);
		}
		setSelectionCount(selection.getLength());
	}, []);

	const removeDrawInteraction = useCallback(() => {
		if (mapRef.current && drawInteractionRef.current) {
			mapRef.current.removeInteraction(drawInteractionRef.current);
		}
		drawInteractionRef.current = null;
	}, [mapRef]);

	const clearInteractions = useCallback(() => {
		removeDrawInteraction();
		if (mapRef.current && selectInteractionRef.current) {
			mapRef.current.removeInteraction(selectInteractionRef.current);
		}
		if (mapRef.current && modifyInteractionRef.current) {
			mapRef.current.removeInteraction(modifyInteractionRef.current);
		}
		selectInteractionRef.current = null;
		modifyInteractionRef.current = null;
		setSelectionCount(0);

		if (mapContainerRef.current) {
			mapContainerRef.current.style.cursor = "";
		}
	}, [mapContainerRef, mapRef, removeDrawInteraction]);

	const setEditableLayerVisibility = useCallback((visible: boolean) => {
		editableAOILayerRef.current?.setVisible(visible);
	}, []);

	const finishDrawing = useCallback((nextMode: "idle" | "editing") => {
		removeDrawInteraction();
		setMode(nextMode);
		if (nextMode === "editing") {
			selectInteractionRef.current?.setActive(true);
			modifyInteractionRef.current?.setActive(true);
			if (mapContainerRef.current) {
				mapContainerRef.current.style.cursor = "pointer";
			}
		} else if (mapContainerRef.current) {
			mapContainerRef.current.style.cursor = "";
		}
	}, [mapContainerRef, removeDrawInteraction]);

	const startDrawing = useCallback(() => {
		if (!enabled || !mapRef.current) return;
		const source = getSource();
		if (!source) return;

		clearInteractions();
		setEditableLayerVisibility(true);

		const draw = new Draw({
			source,
			type: "Polygon",
			freehandCondition: shiftKeyOnly,
			style: new Style({
				stroke: new Stroke({
					color: mapColors.aoi.stroke,
					width: 2,
					lineDash: [5, 5],
				}),
				fill: new Fill({ color: mapColors.aoi.fill }),
			}),
		});

		draw.once("drawstart", snapshot);
		draw.once("drawend", (event) => {
			const drawnFeature = event.feature;
			queueMicrotask(() => {
				if (!source.getFeatures().includes(drawnFeature)) {
					source.addFeature(drawnFeature);
				}
				clearInteractions();
				setMode("idle");
				setShowEditableLayer(true);
				syncFromSource();
				message.success("Polygon drawn successfully.");
			});
		});

		mapRef.current.addInteraction(draw);
		drawInteractionRef.current = draw;
		setMode("drawing");
		if (mapContainerRef.current) {
			mapContainerRef.current.style.cursor = "crosshair";
		}
	}, [
		clearInteractions,
		enabled,
		getSource,
		mapContainerRef,
		mapRef,
		setEditableLayerVisibility,
		snapshot,
		syncFromSource,
	]);

	const cancelDrawing = useCallback(() => {
		const wasCutting = mode === "cutting";
		finishDrawing(wasCutting ? "editing" : "idle");
		setShowEditableLayer(wasCutting || hasAOI);
		message.info(wasCutting ? "Cut cancelled" : "Drawing cancelled");
	}, [finishDrawing, hasAOI, mode]);

	const setupEditingInteractions = useCallback(() => {
		if (!mapRef.current || !editableAOILayerRef.current) return false;
		const source = getSource();
		if (!source || source.getFeatures().length === 0) return false;

		clearInteractions();

		const select = new Select({
			condition: click,
			layers: [editableAOILayerRef.current],
			style: new Style({
				stroke: new Stroke({ color: palette.state.hover, width: 3 }),
				fill: new Fill({ color: "rgba(0, 255, 255, 0.1)" }),
			}),
		});
		selectInteractionRef.current = select;
		select.on("select", syncSelection);

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
		modify.once("modifystart", snapshot);
		modify.on("modifyend", () => {
			syncFromSource();
			modify.once("modifystart", snapshot);
		});
		modifyInteractionRef.current = modify;

		mapRef.current.addInteraction(select);
		mapRef.current.addInteraction(modify);
		return true;
	}, [clearInteractions, getSource, mapRef, snapshot, syncFromSource, syncSelection]);

	const startEditing = useCallback(() => {
		if (!enabled || !hasAOI) {
			message.error("No AOI to edit.");
			return;
		}

		editCheckpointRef.current = checkpoint();
		setEditableLayerVisibility(true);
		clearSelection();
		if (!setupEditingInteractions()) {
			editCheckpointRef.current = null;
			message.error("Could not start editing. AOI feature might be missing.");
			return;
		}

		setMode("editing");
		message.info("Click a polygon to edit it. Shift-click to select two polygons.");
		if (mapContainerRef.current) {
			mapContainerRef.current.style.cursor = "pointer";
		}
	}, [
		clearSelection,
		checkpoint,
		enabled,
		hasAOI,
		mapContainerRef,
		setEditableLayerVisibility,
		setupEditingInteractions,
	]);

	const saveEditing = useCallback(() => {
		clearInteractions();
		editCheckpointRef.current = null;
		setMode("idle");
		setShowEditableLayer(true);
		message.success("AOI edits applied. Save AOI to persist.");
	}, [clearInteractions]);

	const cancelEditing = useCallback(() => {
		clearInteractions();
		const editCheckpoint = editCheckpointRef.current;
		if (editCheckpoint) {
			restore(editCheckpoint);
		}
		editCheckpointRef.current = null;
		setMode("idle");
		setShowEditableLayer(!!editCheckpoint?.geometry);
		message.info("Editing cancelled.");
	}, [clearInteractions, restore]);

	const replaceSelectedFeatures = useCallback((parts: ReturnType<typeof polygonParts>) => {
		const source = getSource();
		const select = selectInteractionRef.current;
		if (!source || !select) return;

		const selected = [...select.getFeatures().getArray()] as Feature<Geometry>[];
		selected.forEach((feature) => source.removeFeature(feature));

		const replacements = parts.map((polygon) => new Feature<Geometry>(polygon.clone()));
		source.addFeatures(replacements);
		select.getFeatures().clear();
		replacements.slice(0, 2).forEach((feature) => select.getFeatures().push(feature));
		syncSelection();
		syncFromSource();
	}, [getSource, syncFromSource, syncSelection]);

	const deleteSelectedPolygon = useCallback(() => {
		const source = getSource();
		const selected = selectInteractionRef.current?.getFeatures().getArray() as Feature<Geometry>[] | undefined;
		if (!source || !selected || selected.length === 0) {
			message.error("Select at least one polygon to delete.");
			return;
		}

		snapshot();
		selected.forEach((feature) => source.removeFeature(feature));
		clearSelection();
		const currentGeometry = syncFromSource();

		if (currentGeometry) {
			message.success(`${selected.length} polygon${selected.length === 1 ? "" : "s"} deleted.`);
		} else {
			clearInteractions();
			editCheckpointRef.current = null;
			setMode("idle");
			setShowEditableLayer(false);
			message.success("Last polygon deleted. Exiting edit mode.");
		}
	}, [clearInteractions, clearSelection, getSource, snapshot, syncFromSource]);

	const mergeSelectedPolygons = useCallback(() => {
		const selected = selectInteractionRef.current?.getFeatures().getArray() as Feature<Geometry>[] | undefined;
		if (!selected || selected.length !== 2) {
			message.warning("Shift-click exactly two polygons to merge.");
			return;
		}

		const first = selected[0].getGeometry();
		const second = selected[1].getGeometry();
		if (!first || !second) return;
		const merged = mergeAOIGeometries(first, second);
		if (!merged) {
			message.error("Failed to merge the selected polygons.");
			return;
		}

		snapshot();
		replaceSelectedFeatures(merged);
		message.success("Polygons merged.");
	}, [replaceSelectedFeatures, snapshot]);

	const clipSelectedPolygons = useCallback(() => {
		const selected = selectInteractionRef.current?.getFeatures().getArray() as Feature<Geometry>[] | undefined;
		if (!selected || selected.length !== 2) {
			message.warning("Shift-click exactly two polygons to clip.");
			return;
		}

		const first = selected[0].getGeometry();
		const second = selected[1].getGeometry();
		if (!first || !second) return;
		const clipped = clipAOIGeometries(first, second);
		if (!clipped) {
			message.error("Failed to clip polygons. The result may be empty.");
			return;
		}

		snapshot();
		replaceSelectedFeatures(clipped);
		message.success("Smaller polygon clipped from larger polygon.");
	}, [replaceSelectedFeatures, snapshot]);

	const cutSelectedPolygon = useCallback(() => {
		if (!mapRef.current) return;
		const select = selectInteractionRef.current;
		const selected = select?.getFeatures().getArray() as Feature<Geometry>[] | undefined;
		if (!select || !selected || selected.length !== 1) {
			message.warning("Select one polygon before cutting.");
			return;
		}

		const targetGeometry = selected[0].getGeometry();
		if (!targetGeometry) return;

		removeDrawInteraction();
		select.setActive(false);
		modifyInteractionRef.current?.setActive(false);

		const draw = new Draw({
			source: new VectorSource<Feature<Geometry>>(),
			type: "Polygon",
			freehandCondition: shiftKeyOnly,
			style: new Style({
				stroke: new Stroke({ color: palette.state.selected, width: 3 }),
				fill: new Fill({ color: "rgba(255, 200, 0, 0.35)" }),
			}),
		});

		draw.once("drawend", (event) => {
			const cutter = event.feature.getGeometry();
			const cutParts = cutter ? cutAOIGeometry(targetGeometry, cutter) : null;
			if (!cutParts) {
				message.error("Failed to cut polygon. The result may be empty.");
			} else {
				snapshot();
				replaceSelectedFeatures(cutParts);
				message.success("Polygon cut.");
			}
			queueMicrotask(() => finishDrawing("editing"));
		});

		mapRef.current.addInteraction(draw);
		drawInteractionRef.current = draw;
		setMode("cutting");
		if (mapContainerRef.current) {
			mapContainerRef.current.style.cursor = "crosshair";
		}
	}, [
		finishDrawing,
		mapContainerRef,
		mapRef,
		removeDrawInteraction,
		replaceSelectedFeatures,
		snapshot,
	]);

	const deleteAOI = useCallback(() => {
		if (!enabled) return;
		if (geometry) {
			snapshot();
		}
		clearInteractions();
		getSource()?.clear();
		syncFromSource();
		editCheckpointRef.current = null;
		setMode("idle");
		setShowEditableLayer(false);
		message.success("AOI draft cleared.");
	}, [clearInteractions, enabled, geometry, getSource, snapshot, syncFromSource]);

	const undo = useCallback(() => {
		clearSelection();
		if (!undoDraft()) return;
		setShowEditableLayer(true);
		message.success("AOI change undone.");
	}, [clearSelection, undoDraft]);

	useEffect(() => {
		if (!enabled || !mapRef.current || editableAOILayerRef.current) return;

		const map = mapRef.current;
		const editableAOILayer = new VectorLayer({
			source: new VectorSource(),
			style: new Style({
				stroke: new Stroke({ color: mapColors.aoi.stroke, width: 3 }),
				fill: new Fill({ color: mapColors.aoi.fill }),
			}),
			zIndex: 100,
		});
		editableAOILayer.setVisible(false);
		map.addLayer(editableAOILayer);
		editableAOILayerRef.current = editableAOILayer;
		repopulateSource();

		return () => {
			clearInteractions();
			map.removeLayer(editableAOILayer);
			editableAOILayerRef.current = null;
		};
	}, [clearInteractions, enabled, mapRef, repopulateSource]);

	useEffect(() => {
		if (!enabled || isAOILoading || !editableAOILayerRef.current || isEditing || isDrawing) return;

		const serializedInitialAOI = JSON.stringify(initialAOI ?? null);
		if (lastInitialAOIRef.current === serializedInitialAOI) return;

		lastInitialAOIRef.current = serializedInitialAOI;
		reset(initialAOI ?? null);
	}, [enabled, initialAOI, isAOILoading, isDrawing, isEditing, reset]);

	useEffect(() => {
		if (!enabled) {
			setEditableLayerVisibility(false);
			return;
		}
		setEditableLayerVisibility(isDrawing || isEditing || showEditableLayer);
	}, [enabled, isDrawing, isEditing, setEditableLayerVisibility, showEditableLayer]);

	useEffect(() => {
		if (!enabled || !onToolbarStateChange) return;

		const polygonCount = geometry?.type === "MultiPolygon"
			? geometry.coordinates.length
			: geometry ? 1 : 0;

		onToolbarStateChange({
			isDrawing,
			drawingMode,
			isEditing,
			hasAOI,
			isAOILoading,
			selectionCount,
			polygonCount,
			canUndo,
		});
	}, [
		canUndo,
		drawingMode,
		enabled,
		geometry,
		hasAOI,
		isAOILoading,
		isDrawing,
		isEditing,
		onToolbarStateChange,
		selectionCount,
	]);

	return {
		isDrawing,
		drawingMode,
		isEditing,
		hasAOI,
		selectionCount,
		canUndo,
		startDrawing,
		cancelDrawing,
		startEditing,
		saveEditing,
		cancelEditing,
		addAnotherPolygon: startDrawing,
		deleteAOI,
		deleteSelectedPolygon,
		mergeSelectedPolygons,
		clipSelectedPolygons,
		cutSelectedPolygon,
		undo,
		editableAOILayer: editableAOILayerRef.current,
	};
}
