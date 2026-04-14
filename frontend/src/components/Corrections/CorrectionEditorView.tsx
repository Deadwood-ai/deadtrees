import { useState, useCallback, useEffect, useRef, useMemo } from "react";
// Navigation is handled via onClose prop
import { message, Button, Spin, Alert } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { Map as OLMap, View } from "ol";
import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { GeoTIFF } from "ol/source";
import Feature from "ol/Feature";
import type { Geometry } from "ol/geom";
import GeoJSON from "ol/format/GeoJSON";
import type BaseLayer from "ol/layer/Base";

import { IDataset } from "../../types/dataset";
import { Settings } from "../../config";
import { EditorToolbar, LayerRadioButtons, type LayerSelection } from "../PolygonEditor";
import usePolygonEditor from "../../hooks/usePolygonEditor";
import useAISegmentation from "../../hooks/useAISegmentation";
import {
  usePredictionLabel,
  useLoadGeometriesForEditing,
  useSaveCorrections,
  buildSavePayload,
  type LayerType,
} from "../../hooks/useSaveCorrections";
import { useAuth } from "../../hooks/useAuthProvider";
import { createDeadwoodVectorLayer, createForestCoverVectorLayer } from "../DatasetDetailsMap/createVectorLayer";
import { useDatasetLabelTypes } from "../../hooks/useDatasetLabelTypes";
import { useDatasetDetailsMap } from "../../hooks/useDatasetDetailsMapProvider";
import { createOpenFreeMapLibertyLayerGroup, createStandardMapControls } from "../../utils/basemaps";

interface Props {
  dataset: IDataset;
  initialLayerType?: LayerType;
  onClose: () => void;
}

export default function CorrectionEditorView({ dataset, initialLayerType, onClose }: Props) {
  const { user } = useAuth();
  const { viewport } = useDatasetDetailsMap();
  const mapRef = useRef<OLMap | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const orthoLayerRef = useRef<TileLayerWebGL | null>(null);
  const deadwoodLayerRef = useRef<ReturnType<typeof createDeadwoodVectorLayer> | null>(null);
  const forestCoverLayerRef = useRef<ReturnType<typeof createForestCoverVectorLayer> | null>(null);

  const [layerSelection, setLayerSelection] = useState<LayerSelection>(initialLayerType || "deadwood");
  const [isEditing, setIsEditing] = useState(false);
  const [initialFeatures, setInitialFeatures] = useState<Feature<Geometry>[]>([]);
  const [, setIsSaving] = useState(false);
  const [isMapReady, setIsMapReady] = useState(false);

  const geoJson = useMemo(() => new GeoJSON(), []);

  // Get current layer type for editing (exclude ortho_only)
  const editingLayerType: LayerType | null =
    layerSelection === "ortho_only" ? null : layerSelection;

  // Fetch label data
  const { deadwood, forestCover, isLoading: isLoadingLabels } = useDatasetLabelTypes({
    datasetId: dataset.id,
    enabled: !!dataset.id,
  });

  // Get active prediction label
  const { data: predictionLabel, isLoading: isLoadingLabel } = usePredictionLabel(
    dataset.id,
    editingLayerType
  );

  // Load geometries when we have a label
  const { data: loadedGeometries, isLoading: isLoadingGeometries } = useLoadGeometriesForEditing(
    predictionLabel?.id,
    editingLayerType
  );

  // Save mutations
  const saveCorrections = useSaveCorrections();

  // Initialize editor hooks
  const editor = usePolygonEditor({ mapRef: mapRef as React.MutableRefObject<OLMap | null> });
  const ai = useAISegmentation({
    mapRef: mapRef as React.MutableRefObject<OLMap | null>,
    getOrthoLayer: () => orthoLayerRef.current || undefined,
    getTargetVectorSource: () => editor.getOverlayLayer()?.getSource() || null,
    onBeforeAddFeatures: editor.saveHistorySnapshot,
  });

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current || !dataset.cog_path) return;

    const orthoCogLayer = new TileLayerWebGL({
      source: new GeoTIFF({
        sources: [
          {
            url: Settings.COG_BASE_URL + dataset.cog_path,
            nodata: 0,
            bands: [1, 2, 3],
          },
        ],
        convertToRGB: true,
      }),
      maxZoom: 23,
      cacheSize: 4096,
      preload: 0,
    });

    orthoLayerRef.current = orthoCogLayer;

    const basemapLayer = createOpenFreeMapLibertyLayerGroup();

    // Create vector layers for visualization (read-only when not editing)
    // Enable correction styling to show pending/approved/deleted with different colors
    const deadwoodVectorLayer = deadwood.data?.id
      ? createDeadwoodVectorLayer(deadwood.data.id, { showCorrectionStyling: true })
      : undefined;
    const forestCoverVectorLayer =
      dataset.is_forest_cover_done && forestCover.data?.id
        ? createForestCoverVectorLayer(forestCover.data.id, { showCorrectionStyling: true })
        : undefined;

    // Store refs for visibility control
    deadwoodLayerRef.current = deadwoodVectorLayer || null;
    forestCoverLayerRef.current = forestCoverVectorLayer || null;

    const orthoCogSource = orthoCogLayer.getSource();
    if (orthoCogSource) {
      orthoCogSource.getView().then((viewOptions) => {
        if (!viewOptions?.extent || !mapContainerRef.current) return;

        // Use viewport from context if available (preserves position from dataset details)
        const hasViewport = viewport.center[0] !== 0 && viewport.zoom !== 2;

        const mapView = new View({
          center: hasViewport ? viewport.center : viewOptions.center,
          zoom: hasViewport ? viewport.zoom : undefined,
          extent: viewOptions.extent,
          minZoom: 14,
          maxZoom: 23,
          projection: "EPSG:3857",
          constrainOnlyCenter: true,
        });

        const layers: BaseLayer[] = [basemapLayer, orthoCogLayer];
        if (forestCoverVectorLayer) layers.push(forestCoverVectorLayer);
        if (deadwoodVectorLayer) layers.push(deadwoodVectorLayer);

        const newMap = new OLMap({
          target: mapContainerRef.current,
          layers,
          view: mapView,
          controls: createStandardMapControls(),
        });

        // Only fit to extent if no viewport from context
        if (!hasViewport) {
          mapView.fit(viewOptions.extent);
        }
        mapRef.current = newMap;
        setIsMapReady(true);
      });
    }

    return () => {
      if (mapRef.current) {
        // Properly dispose layers and sources before disposing map
        mapRef.current.getLayers().forEach((layer) => {
          const source = layer.getSource?.();
          if (source) {
            if ("clear" in source && typeof source.clear === "function") {
              source.clear();
            }
            if ("dispose" in source && typeof source.dispose === "function") {
              source.dispose();
            }
          }
          if ("dispose" in layer && typeof layer.dispose === "function") {
            layer.dispose();
          }
        });
        mapRef.current.setTarget(undefined);
        mapRef.current.dispose();
        mapRef.current = null;
      }
      // Clear layer refs
      orthoLayerRef.current = null;
      deadwoodLayerRef.current = null;
      forestCoverLayerRef.current = null;
    };
  }, [dataset.cog_path, dataset.is_forest_cover_done, deadwood.data?.id, forestCover.data?.id]);

  // Start editing
  const handleStartEditing = useCallback(async () => {
    if (!predictionLabel?.id || !loadedGeometries || !editingLayerType) {
      message.warning("No prediction data available to edit");
      return;
    }

    // Clone features for initial snapshot (for diff calculation)
    const clonedFeatures = loadedGeometries.map((f) => {
      const clone = f.clone();
      clone.set("geometry_id", f.get("geometry_id"));
      clone.set("updated_at", f.get("updated_at"));
      clone.set("is_new", false);
      return clone;
    });
    setInitialFeatures(clonedFeatures);

    // Start editor
    editor.startEditing();
    setIsEditing(true);

    // Load features into overlay
    const overlayLayer = editor.getOverlayLayer();
    if (!overlayLayer) {
      message.error("Editor not initialized properly");
      return;
    }

    const source = overlayLayer.getSource();
    if (!source) {
      message.error("Editor source not initialized");
      return;
    }

    source.clear();
    if (loadedGeometries.length > 0) {
      source.addFeatures(loadedGeometries);
    }

    message.info(
      `Editing ${editingLayerType === "deadwood" ? "Deadwood" : "Forest Cover"} - ${loadedGeometries.length} polygons loaded`
    );
  }, [predictionLabel?.id, loadedGeometries, editingLayerType, editor]);

  // Save edits
  const handleSaveEdits = useCallback(async () => {
    if (!predictionLabel?.id || !editingLayerType || !user?.id) return;

    setIsSaving(true);
    try {
      const currentFeatures = editor.getOverlayLayer()?.getSource()?.getFeatures() || [];
      const { deletions, additions } = buildSavePayload(initialFeatures, currentFeatures, geoJson);

      if (deletions.length === 0 && additions.length === 0) {
        message.info("No changes to save");
        setIsSaving(false);
        return;
      }

      const result = await saveCorrections.mutateAsync({
        datasetId: dataset.id,
        labelId: predictionLabel.id,
        layerType: editingLayerType,
        deletions,
        additions,
      });

      if (!result.success) {
        if (result.conflict_ids && result.conflict_ids.length > 0) {
          message.error(
            `Conflict detected on ${result.conflict_ids.length} polygons. Please reload and try again.`
          );
        } else {
          message.error(result.message);
        }
        setIsSaving(false);
        return;
      }

      message.success("Corrections saved successfully!");

      // Clean up and navigate back to dataset details
      editor.stopEditing();
      editor.getOverlayLayer()?.getSource()?.clear();
      setIsEditing(false);
      setInitialFeatures([]);

      // Navigate back to dataset details
      onClose();
    } catch (error) {
      console.error("Failed to save corrections:", error);
      const errorMsg = error instanceof Error ? error.message : "unknown";
      if (errorMsg.includes("Session expired") || errorMsg.includes("JWT")) {
        message.error("Your session expired. Please sign in again and retry.");
      } else {
        message.error("Failed to save corrections");
      }
    } finally {
      setIsSaving(false);
    }
  }, [
    predictionLabel?.id,
    editingLayerType,
    user?.id,
    dataset.id,
    editor,
    initialFeatures,
    geoJson,
    saveCorrections,
    onClose,
  ]);

  // Cancel editing
  const handleCancelEditing = useCallback(() => {
    editor.stopEditing();
    editor.getOverlayLayer()?.getSource()?.clear();
    setIsEditing(false);
    setInitialFeatures([]);
    message.info("Editing cancelled - no changes saved");
    // Navigate back to dataset details
    onClose();
  }, [editor, onClose]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!isEditing) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Undo: Ctrl/Cmd+Z
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (editor.canUndo) {
          editor.undo();
        }
        return;
      }

      // Save: Ctrl/Cmd+S
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSaveEdits();
        return;
      }

      // Skip if modifier keys (except for above)
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case "s":
          e.preventDefault();
          if (ai.isActive) {
            ai.disable();
          } else {
            ai.enable();
          }
          break;
        case "a":
          e.preventDefault();
          editor.toggleDraw();
          break;
        case "c":
          if (editor.selection && editor.selection.length === 1) {
            e.preventDefault();
            editor.cutHoleWithDrawn();
          }
          break;
        case "d":
          if (editor.selection && editor.selection.length > 0) {
            e.preventDefault();
            editor.deleteSelected();
          }
          break;
        case "g":
          if (editor.selection && editor.selection.length === 2) {
            e.preventDefault();
            editor.mergeSelected();
          }
          break;
        case "x":
          if (editor.selection && editor.selection.length === 2) {
            e.preventDefault();
            editor.clipSelected();
          }
          break;
        case "escape":
          handleCancelEditing();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isEditing, editor, ai, handleSaveEdits, handleCancelEditing]);

  // Layer selection keyboard shortcuts (1/2/3)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (isEditing) return; // Don't switch layers while editing

      switch (e.key) {
        case "1":
          setLayerSelection("ortho_only");
          break;
        case "2":
          setLayerSelection("deadwood");
          break;
        case "3":
          setLayerSelection("forest_cover");
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isEditing]);

  // Control overlay visibility (when editing)
  useEffect(() => {
    if (!isEditing) {
      editor.setOverlayVisible(true);
      return;
    }
    if (layerSelection === "ortho_only") {
      editor.setOverlayVisible(false);
    } else {
      editor.setOverlayVisible(true);
    }
  }, [isEditing, layerSelection, editor]);

  // Control vector layer visibility based on layer selection (when not editing)
  useEffect(() => {
    // When editing, hide the read-only vector layers (user edits in overlay)
    if (isEditing) {
      deadwoodLayerRef.current?.setVisible(false);
      forestCoverLayerRef.current?.setVisible(false);
      return;
    }

    // When not editing, show/hide based on selection
    switch (layerSelection) {
      case "ortho_only":
        deadwoodLayerRef.current?.setVisible(false);
        forestCoverLayerRef.current?.setVisible(false);
        break;
      case "deadwood":
        deadwoodLayerRef.current?.setVisible(true);
        forestCoverLayerRef.current?.setVisible(false);
        break;
      case "forest_cover":
        deadwoodLayerRef.current?.setVisible(false);
        forestCoverLayerRef.current?.setVisible(true);
        break;
    }
  }, [isEditing, layerSelection]);

  // Auto-start editing when component mounts with initialLayerType and data is ready
  const hasAutoStarted = useRef(false);
  useEffect(() => {
    if (
      initialLayerType &&
      !isEditing &&
      !hasAutoStarted.current &&
      isMapReady && // Map must be initialized
      predictionLabel?.id &&
      loadedGeometries &&
      !isLoadingLabels &&
      !isLoadingLabel &&
      !isLoadingGeometries
    ) {
      // Small delay to ensure editor is fully initialized with the map
      const timeoutId = setTimeout(() => {
        // Set flag inside callback to avoid race condition
        hasAutoStarted.current = true;
        try {
          handleStartEditing();
        } catch (error) {
          console.error("Failed to auto-start editing:", error);
          hasAutoStarted.current = false; // Allow retry on failure
        }
      }, 100);

      return () => clearTimeout(timeoutId);
    }
  }, [initialLayerType, isEditing, isMapReady, predictionLabel?.id, loadedGeometries, isLoadingLabels, isLoadingLabel, isLoadingGeometries, handleStartEditing]);

  const isLoading = isLoadingLabels || isLoadingLabel || isLoadingGeometries;
  const canStartEditing = !!predictionLabel?.id && !!loadedGeometries && !isLoading;

  return (
    <div className="flex h-full w-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <Button icon={<ArrowLeftOutlined />} onClick={onClose}>
            Back to Dataset
          </Button>
          <h2 className="m-0 text-lg font-semibold">
            Improve Predictions: {dataset.file_name}
          </h2>
        </div>
        {!isEditing && (
          <Button
            type="primary"
            onClick={handleStartEditing}
            disabled={!canStartEditing}
            loading={isLoading}
          >
            Start Editing{" "}
            {editingLayerType === "deadwood" ? "Deadwood" : "Forest Cover"}
          </Button>
        )}
      </div>

      {/* Map Area */}
      <div className="relative flex-1">
        {isLoading && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-white/50">
            <Spin size="large" tip="Loading..." />
          </div>
        )}

        <div ref={mapContainerRef} className="h-full w-full" />

        {/* Layer Radio Buttons */}
        <LayerRadioButtons
          value={layerSelection}
          onChange={setLayerSelection}
          position="bottom-left"
          availableLayers={
            isEditing
              ? [editingLayerType || "deadwood", "ortho_only"]
              : undefined
          }
          showAOIIndicator={false}
        />

        {/* Editor Toolbar */}
        {isEditing && (
          <EditorToolbar
            type={editingLayerType || "deadwood"}
            isDrawing={editor.isDrawing}
            hasSelection={!!editor.selection && editor.selection.length > 0}
            selectionCount={editor.selection?.length || 0}
            isAIActive={ai.isActive}
            isAIProcessing={ai.isProcessing}
            onToggleDraw={() => editor.toggleDraw()}
            onCutHole={editor.cutHoleWithDrawn}
            onMerge={editor.mergeSelected}
            onClip={editor.clipSelected}
            onToggleAI={() => {
              if (ai.isActive) {
                ai.disable();
              } else {
                ai.enable();
              }
            }}
            onDeleteSelected={editor.deleteSelected}
            onUndo={editor.undo}
            canUndo={editor.canUndo}
            onSave={handleSaveEdits}
            onCancel={handleCancelEditing}
            position="top-right"
            title="Improve Predictions"
          />
        )}

        {/* Instructions when not editing */}
        {!isEditing && !isLoading && (
          <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2">
            <Alert
              message="Click 'Start Editing' to improve the predictions"
              description="You can add, delete, or modify prediction polygons. Your changes will be reviewed before being applied."
              type="info"
              showIcon
            />
          </div>
        )}
      </div>
    </div>
  );
}
