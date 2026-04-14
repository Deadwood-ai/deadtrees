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
import {
  usePredictionLabel,
  useLoadGeometriesForEditing,
  useSaveCorrections,
  buildSavePayload,
  type LayerType,
} from "./useSaveCorrections";
import { useDatasetLabelTypes } from "./useDatasetLabelTypes";

interface UseDatasetEditingOptions {
  datasetId: number | undefined;
  user: User | null;
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

export function useDatasetEditing({ datasetId, user }: UseDatasetEditingOptions) {
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
  const { data: loadedGeometries } = useLoadGeometriesForEditing(predictionLabel?.id, editingLayerType);
  const saveCorrections = useSaveCorrections();

  // Editor hooks
  const editor = usePolygonEditor({ mapRef: mapRef as React.MutableRefObject<OLMap | null> });
  const ai = useAISegmentation({
    mapRef: mapRef as React.MutableRefObject<OLMap | null>,
    getOrthoLayer: () => orthoLayerRef.current ?? undefined,
    getTargetVectorSource: () => editor.getOverlayLayer()?.getSource() ?? undefined,
  });

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
    [user, navigate, editor, emitDebugEvent, hasDeadwood, hasForestCover]
  );

  // Cancel editing
  const handleCancelEditing = useCallback(() => {
    editor.stopEditing();
    editor.getOverlayLayer()?.getSource()?.clear();
    setIsEditing(false);
    setEditingLayerType(null);
    setInitialFeatures([]);
    message.info("Editing cancelled");
  }, [editor]);

  // Save edits
  const handleSaveEdits = useCallback(async () => {
    if (!predictionLabel?.id || !editingLayerType || !user?.id || !datasetId) return;

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
        message.info("No changes to save");
        setIsSaving(false);
        return;
      }

      const result = await saveCorrections.mutateAsync({
        datasetId,
        labelId: predictionLabel.id,
        layerType: editingLayerType,
        deletions,
        additions,
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
        setIsSaving(false);
        return;
      }

      message.success("Corrections saved successfully!");
      editor.stopEditing();
      editor.getOverlayLayer()?.getSource()?.clear();
      setIsEditing(false);
      setEditingLayerType(null);
      setInitialFeatures([]);
      setRefreshKey((k) => k + 1);
    } catch (error) {
      console.error("Failed to save corrections:", error);
      const errorMsg = error instanceof Error ? error.message : "unknown";
      emitDebugEvent("save:error", { message: errorMsg });

      if (errorMsg.includes("Session expired") || errorMsg.includes("JWT")) {
        message.error("Your session expired. Please sign in again and retry.");
      } else {
        message.error("Failed to save corrections");
      }
    } finally {
      setIsSaving(false);
    }
  }, [predictionLabel?.id, editingLayerType, user?.id, datasetId, editor, initialFeatures, geoJson, saveCorrections]);

  // Load geometries into editor when editing starts
  useEffect(() => {
    if (isEditing && loadedGeometries && editingLayerType && mapRef.current && !hasLoadedFeatures.current) {
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
  }, [isEditing, loadedGeometries, editingLayerType, editor, emitDebugEvent]);

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
  }, [isEditing, editor, ai, handleSaveEdits, handleCancelEditing]);

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

    // Callbacks
    handleMapReady,
    handleOrthoLayerReady,
    handleStartEditing,
    handleCancelEditing,
    handleSaveEdits,
  };
}
