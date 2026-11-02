import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { message } from "antd";
import { useNavigate } from "react-router-dom";
import GeoJSON from "ol/format/GeoJSON";
import type { Map as OLMap } from "ol";
import type TileLayerWebGL from "ol/layer/WebGLTile.js";
import type { Feature } from "ol";
import type { Geometry } from "ol/geom";
import type { User } from "@supabase/supabase-js";

import usePolygonEditor from "./usePolygonEditor";
import useAISegmentation from "./useAISegmentation";
import { useAreaTools } from "./useAreaTools";
import { addArea } from "../utils/areaEdits";
import {
  usePredictionLabel,
  useLoadGeometriesForEditing,
  useSaveCorrections,
  buildSavePayload,
  type LayerType,
} from "./useSaveCorrections";
import { useDatasetLabelTypes } from "./useDatasetLabelTypes";
import { trackAppEvent } from "../utils/analytics";

interface UseDatasetEditingOptions {
  datasetId: number | undefined;
  user: User | null;
  /** Set on an audit page: corrections are saved under that page's audit lease. */
  auditLeaseId?: string | null;
}

type EditDebugEvent = {
  ts: string;
  datasetId: number | undefined;
  phase: string;
  details?: Record<string, unknown>;
};


declare global {
  interface Window {
    __DT_EDIT_DEBUG_EVENTS__?: EditDebugEvent[];
    __DT_EDIT_DEBUG_ENABLED__?: boolean;
  }
}

export function useDatasetEditing({ datasetId, user, auditLeaseId }: UseDatasetEditingOptions) {
  const navigate = useNavigate();
  const geoJson = useMemo(() => new GeoJSON(), []);

  const emitDebugEvent = useCallback((phase: string, details?: Record<string, unknown>) => {
    if (typeof window === "undefined") return;
    const event: EditDebugEvent = {
      ts: new Date().toISOString(),
      datasetId,
      phase,
      details,
    };
    if (!window.__DT_EDIT_DEBUG_EVENTS__) {
      window.__DT_EDIT_DEBUG_EVENTS__ = [];
    }
    window.__DT_EDIT_DEBUG_EVENTS__.push(event);
    // Keep bounded history
    if (window.__DT_EDIT_DEBUG_EVENTS__.length > 500) {
      window.__DT_EDIT_DEBUG_EVENTS__.shift();
    }
    if (import.meta.env.DEV || window.__DT_EDIT_DEBUG_ENABLED__) {
      console.debug(`[DT_EDIT_DEBUG] ${JSON.stringify(event)}`);
    }
  }, [datasetId]);

  // State
  const [isEditing, setIsEditing] = useState(false);
  const [editingLayerType, setEditingLayerType] = useState<LayerType | null>(null);
  const [initialFeatures, setInitialFeatures] = useState<Feature<Geometry>[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Refs
  const mapRef = useRef<OLMap | null>(null);
  const orthoLayerRef = useRef<TileLayerWebGL | null>(null);
  const hasLoadedFeatures = useRef(false);

  // Hooks for data
  const { deadwood: deadwoodLabel, forestCover: forestCoverLabel } = useDatasetLabelTypes({
    datasetId,
    enabled: !!datasetId,
  });

  const { data: predictionLabel } = usePredictionLabel(datasetId, editingLayerType);
  const { data: loadedGeometries, isFetching: isFetchingGeometries } = useLoadGeometriesForEditing(
    predictionLabel?.id,
    editingLayerType,
  );
  const saveCorrections = useSaveCorrections();

  // Editor hooks
  const editor = usePolygonEditor({ mapRef: mapRef as React.MutableRefObject<OLMap | null> });
  const ai = useAISegmentation({
    mapRef: mapRef as React.MutableRefObject<OLMap | null>,
    getOrthoLayer: () => orthoLayerRef.current ?? undefined,
    getTargetVectorSource: () => editor.getOverlayLayer()?.getSource() ?? undefined,
    onBeforeAddFeatures: editor.saveHistorySnapshot,
  });
  const disableAI = ai.disable;
  const areaTools = useAreaTools({
    mapRef: mapRef as React.MutableRefObject<OLMap | null>,
    getTargetSource: () => editor.getOverlayLayer()?.getSource(),
    onBeforeChange: editor.saveHistorySnapshot,
    findInArea: ai.findInArea,
  });
  const { cancel: cancelAreaTool, discardPreview } = areaTools;
  // Text for "Find in area"; follows the layer until the user types their own.
  const [findPrompt, setFindPrompt] = useState("");
  // Polygons copied from the other layer, merged in once that layer has loaded.
  const pendingCopyRef = useRef<Geometry[]>([]);

  // Derived state
  const hasDeadwood = !!deadwoodLabel.data?.id;
  const hasForestCover = !!forestCoverLabel.data?.id;

  // Map ready callbacks
  const handleMapReady = useCallback((map: OLMap) => {
    mapRef.current = map;
  }, []);

  const handleOrthoLayerReady = useCallback((layer: TileLayerWebGL) => {
    orthoLayerRef.current = layer;
  }, []);

  // Start editing
  const handleStartEditing = useCallback(
    (layerType: LayerType) => {
      emitDebugEvent("start-editing:requested", {
        layerType,
        hasUser: !!user,
        hasMap: !!mapRef.current,
        hasDeadwood,
        hasForestCover,
      });
      if (!user) {
        message.info("Please login to edit predictions");
        navigate("/sign-in");
        return;
      }
      setEditingLayerType(layerType);
      setIsEditing(true);
      if (datasetId) {
        trackAppEvent("edit_started", {
          dataset_id: datasetId,
          layer_type: layerType,
        });
      }
      editor.startEditing();
      const overlaySource = editor.getOverlayLayer()?.getSource();
      emitDebugEvent("start-editing:after-editor-start", {
        layerType,
        hasMap: !!mapRef.current,
        hasOverlayLayer: !!editor.getOverlayLayer(),
        hasOverlaySource: !!overlaySource,
        overlayFeatureCount: overlaySource?.getFeatures()?.length ?? null,
      });
    },
    [datasetId, user, navigate, editor, emitDebugEvent, hasDeadwood, hasForestCover]
  );

  /** Ends AI, area drawing and any search preview; unlocks the map. */
  const stopTools = useCallback(() => {
    disableAI();
    cancelAreaTool();
    discardPreview();
  }, [disableAI, cancelAreaTool, discardPreview]);

  // Cancel editing
  const handleCancelEditing = useCallback(() => {
    if (datasetId && editingLayerType) {
      trackAppEvent("edit_cancelled", {
        dataset_id: datasetId,
        layer_type: editingLayerType,
      });
    }
    stopTools();
    editor.stopEditing();
    editor.getOverlayLayer()?.getSource()?.clear();
    setIsEditing(false);
    setEditingLayerType(null);
    setInitialFeatures([]);
    message.info("Editing cancelled");
  }, [datasetId, editingLayerType, editor, stopTools]);

  /**
   * Saves the active layer's changes and keeps editing. Returns false when the save failed,
   * true when it was saved or there was nothing to save.
   */
  const saveCurrentLayer = useCallback(async ({ quiet = false } = {}): Promise<boolean> => {
    if (!predictionLabel?.id || !editingLayerType || !user?.id || !datasetId) return false;

    setIsSaving(true);
    try {
      const currentFeatures = editor.getOverlayLayer()?.getSource()?.getFeatures() || [];
      emitDebugEvent("save:before-diff", {
        labelId: predictionLabel.id,
        layerType: editingLayerType,
        initialCount: initialFeatures.length,
        currentCount: currentFeatures.length,
        hasOverlayLayer: !!editor.getOverlayLayer(),
        hasOverlaySource: !!editor.getOverlayLayer()?.getSource(),
      });
      const { deletions, additions } = buildSavePayload(initialFeatures, currentFeatures, geoJson);
      emitDebugEvent("save:after-diff", {
        deletions: deletions.length,
        additions: additions.length,
      });

      if (deletions.length === 0 && additions.length === 0) {
        if (!quiet) message.info("No changes to save");
        return true;
      }

      const result = await saveCorrections.mutateAsync({
        datasetId,
        labelId: predictionLabel.id,
        layerType: editingLayerType,
        deletions,
        additions,
        auditLeaseId,
      });
      emitDebugEvent("save:rpc-result", {
        success: result.success,
        message: result.message,
        conflictCount: result.conflict_ids?.length ?? 0,
      });

      if (!result.success) {
        if (result.conflict_ids && result.conflict_ids.length > 0) {
          message.error(`Conflict detected on ${result.conflict_ids.length} polygons. Please reload and try again.`);
        } else {
          message.error(result.message);
        }
        return false;
      }

      message.success("Corrections saved successfully!");
      trackAppEvent("edit_saved", {
        dataset_id: datasetId,
        layer_type: editingLayerType,
      });
      setRefreshKey((k) => k + 1);
      return true;
    } catch (error) {
      console.error("Failed to save corrections:", error);
      const errorMsg = error instanceof Error ? error.message : "unknown";
      emitDebugEvent("save:error", { message: errorMsg });

      if (errorMsg.includes("Session expired") || errorMsg.includes("JWT")) {
        message.error("Your session expired. Please sign in again and retry.");
      } else {
        message.error("Failed to save corrections");
      }
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [predictionLabel?.id, editingLayerType, user?.id, datasetId, editor, initialFeatures, geoJson, saveCorrections, emitDebugEvent, auditLeaseId]);

  // Save edits and leave editing
  const handleSaveEdits = useCallback(async () => {
    if (!(await saveCurrentLayer())) return;
    stopTools();
    editor.stopEditing();
    editor.getOverlayLayer()?.getSource()?.clear();
    setIsEditing(false);
    setEditingLayerType(null);
    setInitialFeatures([]);
  }, [saveCurrentLayer, stopTools, editor]);

  /**
   * Switches the session to the other prediction layer: saves the active one first, then loads
   * the other. `copy` polygons are merged into the new layer as one undo step.
   */
  const switchLayer = useCallback(async (target: LayerType, copy: Geometry[] = []) => {
    if (!isEditing || isSaving || target === editingLayerType) return;
    if (target === "deadwood" ? !hasDeadwood : !hasForestCover) {
      message.info(`This dataset has no ${target === "deadwood" ? "deadwood" : "tree cover"} layer.`);
      return;
    }
    if (!(await saveCurrentLayer({ quiet: true }))) return;
    stopTools();
    pendingCopyRef.current = copy;
    hasLoadedFeatures.current = false;
    editor.getOverlayLayer()?.getSource()?.clear();
    setInitialFeatures([]);
    setFindPrompt("");
    setEditingLayerType(target);
  }, [isEditing, isSaving, editingLayerType, hasDeadwood, hasForestCover, saveCurrentLayer, stopTools, editor]);

  /** Copies the selected polygons into the other layer and switches to it. */
  const copySelectionToOtherLayer = useCallback(() => {
    const copies = editor.selection.map((f) => f.getGeometry()?.clone()).filter((g): g is Geometry => !!g);
    if (copies.length === 0 || !editingLayerType) {
      message.info("Select the polygons to copy first.");
      return;
    }
    void switchLayer(editingLayerType === "deadwood" ? "forest_cover" : "deadwood", copies);
  }, [editor.selection, editingLayerType, switchLayer]);

  // Load geometries into editor when editing starts
  useEffect(() => {
    if (isEditing && loadedGeometries && !isFetchingGeometries && editingLayerType && mapRef.current && !hasLoadedFeatures.current) {
      emitDebugEvent("load-geometries:effect-enter", {
        layerType: editingLayerType,
        loadedCount: loadedGeometries.length,
        hasMap: !!mapRef.current,
        hasLoadedFeatures: hasLoadedFeatures.current,
        hasOverlayLayer: !!editor.getOverlayLayer(),
        hasOverlaySource: !!editor.getOverlayLayer()?.getSource(),
      });

      // Clone features for diff calculation
      const clonedFeatures = loadedGeometries.map((f) => {
        const clone = f.clone();
        clone.set("geometry_id", f.get("geometry_id"));
        clone.set("updated_at", f.get("updated_at"));
        return clone;
      });
      setInitialFeatures(clonedFeatures);

      // Load into editor overlay
      const overlaySource = editor.getOverlayLayer()?.getSource();
      if (overlaySource) {
        hasLoadedFeatures.current = true;
        overlaySource.clear();
        loadedGeometries.forEach((f) => overlaySource.addFeature(f));
        const copies = pendingCopyRef.current;
        pendingCopyRef.current = [];
        if (copies.length > 0) {
          editor.saveHistorySnapshot();
          for (const geometry of copies) {
            const edit = addArea(overlaySource.getFeatures() as Feature<Geometry>[], geometry);
            edit.removed.forEach((f) => overlaySource.removeFeature(f));
            overlaySource.addFeatures(edit.added);
          }
          message.success(`Copied ${copies.length} polygons. Save to keep them.`);
        }
        emitDebugEvent("load-geometries:overlay-populated", {
          loadedCount: loadedGeometries.length,
          overlayCount: overlaySource.getFeatures().length,
        });
      } else {
        emitDebugEvent("load-geometries:overlay-missing-window", {
          loadedCount: loadedGeometries.length,
          note: "Potential race window: initialFeatures set but overlay source missing",
        });
      }
    }
    if (!isEditing) {
      hasLoadedFeatures.current = false;
      emitDebugEvent("load-geometries:editing-stopped");
    }
  }, [isEditing, loadedGeometries, isFetchingGeometries, editingLayerType, editor, emitDebugEvent]);

  const findPromptText = findPrompt || (editingLayerType === "deadwood" ? "dead tree" : "tree");

  // Keyboard shortcuts
  useEffect(() => {
    if (!isEditing) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Undo: Ctrl/Cmd+Z
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (editor.canUndo) editor.undo();
        return;
      }

      // Save: Ctrl/Cmd+S
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSaveEdits();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case "1":
          e.preventDefault();
          void switchLayer("deadwood");
          break;
        case "2":
          e.preventDefault();
          void switchLayer("forest_cover");
          break;
        case "q":
          e.preventDefault();
          areaTools.start("add");
          break;
        case "e":
          e.preventDefault();
          areaTools.start("remove");
          break;
        case "f":
          e.preventDefault();
          areaTools.start("find", findPromptText);
          break;
        case "t":
          if (editor.selection?.length > 0) {
            e.preventDefault();
            copySelectionToOtherLayer();
          }
          break;
        case "s":
          e.preventDefault();
          ai.isActive ? ai.disable() : ai.enable();
          break;
        case "a":
          e.preventDefault();
          editor.toggleDraw();
          break;
        case "c":
          if (editor.selection?.length === 1) {
            e.preventDefault();
            editor.cutHoleWithDrawn();
          }
          break;
        case "d":
          if (editor.selection?.length > 0) {
            e.preventDefault();
            editor.deleteSelected();
          }
          break;
        case "g":
          if (editor.selection?.length === 2) {
            e.preventDefault();
            editor.mergeSelected();
          }
          break;
        case "x":
          if (editor.selection?.length === 2) {
            e.preventDefault();
            editor.clipSelected();
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isEditing, editor, ai, areaTools, findPromptText, switchLayer, copySelectionToOtherLayer, handleSaveEdits, handleCancelEditing]);

  return {
    // State
    isEditing,
    editingLayerType,
    isSaving,
    refreshKey,

    // Layer availability
    hasDeadwood,
    hasForestCover,

    // Editor instances
    editor,
    ai,
    areaTools,
    findPrompt: findPromptText,
    setFindPrompt,

    // Callbacks
    handleMapReady,
    handleOrthoLayerReady,
    handleStartEditing,
    handleCancelEditing,
    handleSaveEdits,
    switchLayer,
    copySelectionToOtherLayer,
  };
}
