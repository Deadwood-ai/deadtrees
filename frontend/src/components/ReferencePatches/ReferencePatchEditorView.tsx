import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { IDataset } from "../../types/dataset";
import { IReferencePatch, PatchResolution } from "../../types/referencePatches";
import { ILabelData } from "../../types/labels";
import {
  useReferencePatches,
  useCreateReferencePatch,
  useUpdatePatchStatus,
  useUpdatePatchLayerValidation,
  useDeleteReferencePatch,
} from "../../hooks/useReferencePatches";
import { useSaveReferenceGeometries } from "../../hooks/useReferenceGeometries";
import { clipGeometriesInBatches } from "../../hooks/useReferenceGeometriesBatch";
import usePolygonEditor from "../../hooks/usePolygonEditor";
import useAISegmentation from "../../hooks/useAISegmentation";
import { useDatasetAOI } from "../../hooks/useDatasetAudit";
import { supabase } from "../../hooks/useSupabase";
import { message, Button, Alert, Modal } from "antd";
import { PlusOutlined, LockOutlined, EditOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import { polygon as turfPolygon, multiPolygon as turfMultiPolygon, centroid } from "@turf/turf";
import GeoJSON from "ol/format/GeoJSON";
import type { Map as OLMap } from "ol";
import Feature from "ol/Feature";
import type TileLayerWebGL from "ol/layer/WebGLTile";
import ReferencePatchMap from "./ReferencePatchMap";
import PatchDetailSidebar from "./PatchDetailSidebar";
import { LayerRadioButtons, EditorToolbar, type LayerSelection } from "../PolygonEditor";
import { findBasePatchForPatch, getPreferredDefaultPatch } from "./utils/patchSelection";
import { MAP_FLOATING_CHILD_TOP_CLASS, MAP_REFERENCE_SIDEBAR_WIDTH_CLASS } from "../../theme/mapLayout";
import { useReferenceEditorKeyboardShortcuts } from "./hooks/useReferenceEditorKeyboardShortcuts";

interface Props {
  dataset: IDataset;
  onUnsavedChanges: (hasChanges: boolean) => void;
  isCompleted: boolean;
  onReopenForEditing: () => void;
}

const isTextInputTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

export default function ReferencePatchEditorView({
  dataset,
  onUnsavedChanges,
  isCompleted,
  onReopenForEditing,
}: Props) {
  const [selectedResolution, setSelectedResolution] = useState<PatchResolution>(20);
  const [selectedPatchId, setSelectedPatchId] = useState<number | null>(null);
  const [getPatchGeometryFromMap, setGetPatchGeometryFromMap] = useState<
    ((patchId: number) => GeoJSON.Polygon | null) | null
  >(null);
  const [layerSelection, setLayerSelection] = useState<LayerSelection>("deadwood");
  const [editingMode, setEditingMode] = useState<ILabelData | null>(null);
  const [batchProgress, setBatchProgress] = useState<{
    layer: "deadwood" | "forest_cover" | null;
    current: number;
    total: number;
    percentage: number;
  } | null>(null);

  // Ref for OpenLayers map
  const mapRef = useRef<OLMap | null>(null);
  const [getOrthoLayer, setGetOrthoLayer] = useState<(() => TileLayerWebGL | undefined) | null>(null);

  const { data: allPatches = [], refetch: refetchPatches } = useReferencePatches(dataset.id);
  const { data: aoiData } = useDatasetAOI(dataset.id);
  const { mutateAsync: createPatch } = useCreateReferencePatch();
  const { mutateAsync: updateStatus } = useUpdatePatchStatus();
  const { mutateAsync: updateLayerValidation } = useUpdatePatchLayerValidation();
  const { mutateAsync: deletePatch } = useDeleteReferencePatch();
  const { mutateAsync: saveGeometries } = useSaveReferenceGeometries();

  // Initialize editor hooks (only when map is ready)
  const editor = usePolygonEditor({ mapRef: mapRef as React.MutableRefObject<OLMap | null> });
  const ai = useAISegmentation({
    mapRef: mapRef as React.MutableRefObject<OLMap | null>,
    getOrthoLayer: getOrthoLayer || (() => undefined),
    getTargetVectorSource: () => editor.getOverlayLayer()?.getSource() || null,
    onBeforeAddFeatures: editor.saveHistorySnapshot, // Save history before AI adds features (for undo)
  });

  const geoJson = useMemo(() => new GeoJSON(), []);

  const aoiCentroid = useMemo(() => {
    if (!aoiData?.geometry) return null;
    try {
      const aoiGeometry = geoJson.readGeometry(aoiData.geometry, {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      });
      const aoiGeoJSON = geoJson.writeGeometryObject(aoiGeometry) as GeoJSON.Polygon | GeoJSON.MultiPolygon;
      const turfGeom =
        aoiGeoJSON.type === "Polygon"
          ? turfPolygon(aoiGeoJSON.coordinates as GeoJSON.Position[][])
          : turfMultiPolygon(aoiGeoJSON.coordinates as GeoJSON.Position[][][]);
      return centroid(turfGeom).geometry.coordinates as [number, number];
    } catch (error) {
      console.error("Failed to calculate AOI centroid:", error);
      return null;
    }
  }, [aoiData?.geometry, geoJson]);

  // Filter patches for map display
  // Always show base patches (20cm) + patches at selected resolution
  const patchesForResolution = useMemo(() => {
    if (selectedResolution === 20) {
      // If viewing 20cm, only show 20cm patches
      return allPatches.filter((p) => p.resolution_cm === 20);
    } else {
      // If viewing 10cm or 5cm, show base patches (20cm) + the selected resolution
      return allPatches.filter((p) => p.resolution_cm === 20 || p.resolution_cm === selectedResolution);
    }
  }, [allPatches, selectedResolution]);

  // Get the selected patch
  const selectedPatch = useMemo(
    () => allPatches.find((p) => p.id === selectedPatchId) || null,
    [allPatches, selectedPatchId],
  );
  const hasBasePatch = useMemo(
    () => allPatches.some((patch) => patch.resolution_cm === 20 && patch.parent_tile_id === null),
    [allPatches],
  );

  // In non-edit mode, default to a 5cm patch when available (QA-first workflow).
  // Fallback to a base patch if no 5cm patches exist yet.
  useEffect(() => {
    if (editingMode || selectedPatchId || allPatches.length === 0) return;

    const patchToSelect = getPreferredDefaultPatch(allPatches);

    if (patchToSelect) {
      setSelectedPatchId(patchToSelect.id);
      setSelectedResolution(patchToSelect.resolution_cm);
    }
  }, [editingMode, selectedPatchId, allPatches]);

  // Get base patch for selected patch
  const selectedBasePatch = useMemo(() => {
    if (!selectedPatch) return null;
    const basePatch = findBasePatchForPatch(selectedPatch, allPatches);
    if (!basePatch) return null;

    console.debug("[Editor] selectedBasePatch updated:", {
      id: basePatch.id,
      deadwoodLabel: basePatch.reference_deadwood_label_id,
      forestCoverLabel: basePatch.reference_forest_cover_label_id,
    });

    return basePatch;
  }, [selectedPatch, allPatches]);

  // Recursively generate nested patches
  const generateNestedPatchesRecursive = useCallback(
    async (parentPatch: IReferencePatch) => {
      const { createUtmSquare, getTargetGroundSize } = await import("../../utils/utm");

      const parentGeom = parentPatch.geometry;
      const parentCoords = parentGeom.coordinates[0];
      const [minx, miny] = parentCoords[0];
      const [maxx, maxy] = parentCoords[2];
      const centerX = (minx + maxx) / 2;
      const centerY = (miny + maxy) / 2;
      const halfWidth = (maxx - minx) / 2;
      const halfHeight = (maxy - miny) / 2;
      const utmZone = parentPatch.utm_zone;
      const epsgCode = parentPatch.epsg_code; // Inherit EPSG from parent

      const childResolution = parentPatch.resolution_cm === 20 ? 10 : 5;
      const targetGroundSize = getTargetGroundSize(childResolution);

      const positions = [
        [centerX - halfWidth / 2, centerY - halfHeight / 2],
        [centerX + halfWidth / 2, centerY - halfHeight / 2],
        [centerX - halfWidth / 2, centerY + halfHeight / 2],
        [centerX + halfWidth / 2, centerY + halfHeight / 2],
      ];

      // Create all 4 child patches in parallel for better performance
      const patchCreationPromises = positions.map((position, i) => {
        const [cx, cy] = position;
        // Create exact square in UTM (no distortion correction needed!)
        const childGeometry = createUtmSquare(cx, cy, targetGroundSize);

        return createPatch({
          dataset_id: dataset.id,
          resolution_cm: childResolution,
          geometry: childGeometry,
          utm_zone: utmZone,
          epsg_code: epsgCode, // Inherit from parent
          parent_tile_id: parentPatch.id,
          patch_index: `${parentPatch.patch_index}_${i}`,
          bbox_minx: childGeometry.coordinates[0][0][0],
          bbox_miny: childGeometry.coordinates[0][0][1],
          bbox_maxx: childGeometry.coordinates[0][2][0],
          bbox_maxy: childGeometry.coordinates[0][2][1],
          aoi_coverage_percent: null,
          deadwood_prediction_coverage_percent: null,
          forest_cover_prediction_coverage_percent: null,
          deadwood_validated: null,
          forest_cover_validated: null,
        });
      });

      const childPatches = await Promise.all(patchCreationPromises);

      // If we just created 10cm patches, recursively create 5cm patches in parallel
      if (childResolution === 10) {
        await Promise.all(childPatches.map((child) => generateNestedPatchesRecursive(child as IReferencePatch)));
      }
    },
    [createPatch, dataset.id],
  );

  // Handle adding a new base patch (without auto-generating children)
  const handleAddBasePatch = useCallback(async () => {
    if (!aoiCentroid) {
      message.warning("AOI required before placing base patches.");
      return;
    }

    const { getUtmZoneFromWebMercator, webMercatorToUtm, createUtmSquare, getTargetGroundSize, getUtmEpsgCode } =
      await import("../../utils/utm");

    const utmZone = getUtmZoneFromWebMercator(aoiCentroid[0], aoiCentroid[1]);
    const epsgCode = getUtmEpsgCode(utmZone);
    const [centerUtmX, centerUtmY] = webMercatorToUtm(aoiCentroid[0], aoiCentroid[1], utmZone);
    const targetGroundSize = getTargetGroundSize(20); // 204.8m for 20cm resolution
    const patchGeometry = createUtmSquare(centerUtmX, centerUtmY, targetGroundSize);

    if (hasBasePatch) {
      message.info("This dataset already has a base patch.");
      return;
    }

    try {
      // Create base patch in pending state (user will position it, then generate children)
      const newPatch = await createPatch({
        dataset_id: dataset.id,
        resolution_cm: 20,
        geometry: patchGeometry,
        utm_zone: utmZone,
        epsg_code: epsgCode,
        parent_tile_id: null,
        patch_index: `20_${Date.now()}`,
        bbox_minx: patchGeometry.coordinates[0][0][0],
        bbox_miny: patchGeometry.coordinates[0][0][1],
        bbox_maxx: patchGeometry.coordinates[0][2][0],
        bbox_maxy: patchGeometry.coordinates[0][2][1],
        aoi_coverage_percent: 100,
        deadwood_prediction_coverage_percent: null,
        forest_cover_prediction_coverage_percent: null,
        deadwood_validated: null,
        forest_cover_validated: null,
      });

      // Explicitly refetch to ensure UI updates immediately
      await refetchPatches();

      // Auto-select the newly created patch
      if (newPatch && newPatch.id) {
        setSelectedPatchId(newPatch.id);
        setSelectedResolution(20);
      }

      onUnsavedChanges(true);
      message.success("Base patch created. Drag it to position, then select it to generate sub-patches.");
    } catch (error) {
      console.error(error);
      message.error("Failed to create base patch");
    }
  }, [aoiCentroid, hasBasePatch, dataset.id, createPatch, onUnsavedChanges, refetchPatches]);

  // Handle patch selection
  const handlePatchSelected = useCallback((patch: IReferencePatch | null) => {
    if (patch) {
      setSelectedPatchId(patch.id);
      setSelectedResolution(patch.resolution_cm);
    } else {
      setSelectedPatchId(null);
    }
  }, []);

  // Handle patch deselection
  const handleDeselect = useCallback(() => {
    setSelectedPatchId(null);
    message.info("Patch deselected");
  }, []);

  // Handle edit layer button click
  const handleEditLayer = useCallback(async () => {
    if (!selectedPatchId || layerSelection === "ortho_only") return;

    console.debug("=== Starting Edit Mode ===");
    console.debug("Map ref:", mapRef.current);
    console.debug("Editor:", editor);

    // Check if map is ready
    if (!mapRef.current) {
      message.error("Map is not ready yet");
      return;
    }

    // Find base patch
    const selectedPatch = allPatches.find((p) => p.id === selectedPatchId);
    if (!selectedPatch) return;
    const basePatch = findBasePatchForPatch(selectedPatch, allPatches);
    if (!basePatch) return;

    const layerType: ILabelData = layerSelection === "deadwood" ? ILabelData.DEADWOOD : ILabelData.FOREST_COVER;

    // Load reference geometries
    try {
      // Fetch geometries from database
      const tableName =
        layerType === "deadwood" ? "reference_patch_deadwood_geometries" : "reference_patch_forest_cover_geometries";

      // Get active label for this patch
      const { data: labelData } = await supabase
        .from("v2_labels")
        .select("id")
        .eq("reference_patch_id", basePatch.id)
        .eq("label_data", layerType)
        .eq("is_active", true)
        .maybeSingle();

      let features: Feature[] = [];

      if (labelData) {
        // Fetch geometries
        const { data: geometries } = await supabase.from(tableName).select("geometry").eq("label_id", labelData.id);

        if (geometries && geometries.length > 0) {
          features = geometries.map((g) => {
            const feature = new Feature(
              geoJson.readGeometry(g.geometry, {
                dataProjection: "EPSG:4326", // Database stores in WGS84
                featureProjection: "EPSG:3857", // Map uses Web Mercator
              }),
            );
            feature.set("label_data", layerType);
            feature.set("patch_id", basePatch.id);
            return feature;
          });
        }
      }

      console.debug("Loaded features:", features.length);

      // Enter editing mode FIRST to initialize the overlay layer
      console.debug("Starting editor...");
      editor.startEditing();
      setEditingMode(layerType);

      // NOW get the overlay layer (it's been created by startEditing)
      const overlayLayer = editor.getOverlayLayer();
      console.debug("Overlay layer after startEditing:", overlayLayer);

      if (!overlayLayer) {
        console.error("Overlay layer not found even after startEditing!");
        message.error("Editor not initialized properly");
        return;
      }

      const source = overlayLayer.getSource();
      if (!source) {
        console.error("Overlay source not found!");
        message.error("Editor source not initialized");
        return;
      }

      // Clear any existing features and add the loaded ones
      source.clear();
      if (features.length > 0) {
        source.addFeatures(features);
        console.debug("Added features to overlay, count:", source.getFeatures().length);
      }

      console.debug("Editor isEditing:", editor.isEditing);
      console.debug("Overlay layer visible:", overlayLayer.getVisible());
      console.debug("Overlay layer z-index:", overlayLayer.getZIndex());

      message.info(
        `Editing ${layerType === "deadwood" ? "Deadwood" : "Forest Cover"} - ${features.length} polygons loaded`,
      );
    } catch (error) {
      console.error("Failed to load geometries for editing:", error);
      message.error("Failed to load geometries");
    }
  }, [layerSelection, selectedPatchId, allPatches, editor, geoJson, mapRef]);

  // Handle save edits
  const handleSaveEdits = useCallback(async () => {
    if (!editingMode || !selectedPatchId) return;

    try {
      // Find base patch
      const selectedPatch = allPatches.find((p) => p.id === selectedPatchId);
      if (!selectedPatch) return;

      const basePatch = findBasePatchForPatch(selectedPatch, allPatches);
      if (!basePatch) return;

      // Get features from overlay
      const features = editor.getOverlayLayer()?.getSource()?.getFeatures() || [];

      // Convert to GeoJSON geometries with coordinate transformation
      const geometries = features.map((f: Feature) =>
        geoJson.writeGeometryObject(f.getGeometry()!, {
          dataProjection: "EPSG:4326", // Database stores in WGS84
          featureProjection: "EPSG:3857", // Map uses Web Mercator
        }),
      );

      // Save to database
      await saveGeometries({
        patchId: basePatch.id,
        datasetId: dataset.id,
        layerType: editingMode,
        geometries,
      });

      // Refetch patches to get updated reference label IDs BEFORE exiting editing mode
      // This ensures the map has fresh data when we exit editing
      console.debug("[Editor] Before refetch, selectedBasePatch:", selectedBasePatch);
      const refetchResult = await refetchPatches();
      console.debug("[Editor] After refetch, patches count:", refetchResult.data?.length);

      const updatedPatch = refetchResult.data?.find((p) => p.id === basePatch.id);
      console.debug("[Editor] Updated patch label IDs:", {
        deadwood: updatedPatch?.reference_deadwood_label_id,
        forestCover: updatedPatch?.reference_forest_cover_label_id,
      });

      // NOW clean up and exit editing mode
      // This ensures the reference geometry useEffect fires with the NEW patch data
      editor.stopEditing();
      editor.getOverlayLayer()?.getSource()?.clear();
      setEditingMode(null);

      message.success(`${editingMode === "deadwood" ? "Deadwood" : "Forest Cover"} reference updated!`);
      onUnsavedChanges(true);
    } catch (error) {
      console.error("Failed to save edits:", error);
      message.error("Failed to save changes");
    }
  }, [
    editingMode,
    selectedPatchId,
    allPatches,
    editor,
    geoJson,
    saveGeometries,
    dataset.id,
    refetchPatches,
    onUnsavedChanges,
    selectedBasePatch,
  ]);

  // Handle cancel editing
  const handleCancelEditing = useCallback(() => {
    editor.stopEditing();
    editor.getOverlayLayer()?.getSource()?.clear();
    setEditingMode(null);
    message.info("Editing cancelled - no changes saved");
  }, [editor]);

  // Control overlay visibility based on layer selection during editing
  useEffect(() => {
    if (!editingMode) {
      // Always show overlay when editing (default state)
      editor.setOverlayVisible(true);
      return;
    }

    // When editing and "ortho_only" is selected, hide overlay
    if (layerSelection === "ortho_only") {
      editor.setOverlayVisible(false);
    } else {
      editor.setOverlayVisible(true);
    }
  }, [editingMode, layerSelection, editor]);

  useReferenceEditorKeyboardShortcuts({
    editingMode,
    selectedPatchId,
    setLayerSelection,
    onEditLayer: handleEditLayer,
    onDeselect: handleDeselect,
    onSaveEdits: handleSaveEdits,
    editor,
    ai,
    isTextInputTarget,
  });

  // Memoize the callback that receives the patch geometry getter
  const handleGetPatchGeometry = useCallback((getter: (patchId: number) => GeoJSON.Polygon | null) => {
    setGetPatchGeometryFromMap(() => getter);
  }, []);

  // Callback to receive map reference from child component
  const handleGetMapRef = useCallback((map: OLMap | null) => {
    mapRef.current = map;
    console.debug("Map reference received:", map);
  }, []);

  // Callback to receive ortho layer getter from child component
  const handleGetOrthoLayer = useCallback((getter: () => TileLayerWebGL | undefined) => {
    setGetOrthoLayer(() => getter);
  }, []);

  // Helper: Auto-copy model predictions to create initial reference data
  // Uses batch processing to avoid timeouts on large datasets
  const autoCopyPredictionsAsReference = useCallback(
    async (basePatch: IReferencePatch) => {
      try {
        console.debug("[Auto-copy] Starting batch processing for patch:", basePatch.id);

        // Fetch model prediction labels for deadwood and forest_cover
        const { data: deadwoodLabel } = await supabase
          .from("v2_labels")
          .select("id")
          .eq("dataset_id", dataset.id)
          .eq("label_data", ILabelData.DEADWOOD)
          .eq("label_source", "model_prediction")
          .maybeSingle();

        const { data: forestCoverLabel } = await supabase
          .from("v2_labels")
          .select("id")
          .eq("dataset_id", dataset.id)
          .eq("label_data", ILabelData.FOREST_COVER)
          .eq("label_source", "model_prediction")
          .maybeSingle();

        const bbox = {
          minx: basePatch.bbox_minx,
          miny: basePatch.bbox_miny,
          maxx: basePatch.bbox_maxx,
          maxy: basePatch.bbox_maxy,
        };

        // Process deadwood geometries in batches
        if (deadwoodLabel) {
          console.debug("[Auto-copy] Processing deadwood geometries");

          const deadwoodGeoms = await clipGeometriesInBatches({
            labelId: deadwoodLabel.id,
            geometryTable: "v2_deadwood_geometries",
            bbox,
            epsgCode: basePatch.epsg_code,
            batchSize: 50,
            onProgress: (progress) => {
              setBatchProgress({
                layer: "deadwood",
                current: progress.current,
                total: progress.total,
                percentage: progress.percentage,
              });
            },
          });

          if (deadwoodGeoms.length > 0) {
            console.debug(`[Auto-copy] Saving ${deadwoodGeoms.length} deadwood geometries`);
            await saveGeometries({
              patchId: basePatch.id,
              datasetId: dataset.id,
              layerType: ILabelData.DEADWOOD,
              geometries: deadwoodGeoms,
            });
          } else {
            console.debug("[Auto-copy] No deadwood geometries found in patch area");
          }
        }

        // Process forest cover geometries in batches
        if (forestCoverLabel) {
          console.debug("[Auto-copy] Processing forest cover geometries");

          const forestCoverGeoms = await clipGeometriesInBatches({
            labelId: forestCoverLabel.id,
            geometryTable: "v2_forest_cover_geometries",
            bbox,
            epsgCode: basePatch.epsg_code,
            batchSize: 50,
            onProgress: (progress) => {
              setBatchProgress({
                layer: "forest_cover",
                current: progress.current,
                total: progress.total,
                percentage: progress.percentage,
              });
            },
          });

          if (forestCoverGeoms.length > 0) {
            console.debug(`[Auto-copy] Saving ${forestCoverGeoms.length} forest cover geometries`);
            await saveGeometries({
              patchId: basePatch.id,
              datasetId: dataset.id,
              layerType: ILabelData.FOREST_COVER,
              geometries: forestCoverGeoms,
            });
          } else {
            console.debug("[Auto-copy] No forest cover geometries found in patch area");
          }
        }

        // Clear progress state
        setBatchProgress(null);
        console.debug("[Auto-copy] Reference data auto-copied successfully");
      } catch (error) {
        // Clear progress on error
        setBatchProgress(null);
        console.error("[Auto-copy] Failed to auto-copy predictions:", error);
        throw error; // Re-throw to be caught by handleGenerateSubPatches
      }
    },
    [dataset.id, saveGeometries],
  );

  // Handle generating sub-patches for a base patch
  const handleGenerateSubPatches = useCallback(
    async (basePatch: IReferencePatch, currentGeometry?: GeoJSON.Polygon) => {
      try {
        message.loading({ content: "Copying model predictions in batches...", key: "generate" });

        // Get current geometry from map if available, otherwise use provided or basePatch geometry
        // This ensures we use the MOVED position if the user translated the patch
        let geometryToUse = currentGeometry || basePatch.geometry;

        if (!currentGeometry && getPatchGeometryFromMap) {
          const mapGeometry = getPatchGeometryFromMap(basePatch.id);
          if (mapGeometry) {
            // ⚠️ Map geometry is in Web Mercator - transform back to UTM!
            const { transformPolygonWebMercatorToUtm } = await import("../../utils/utm");
            geometryToUse = transformPolygonWebMercatorToUtm(mapGeometry, basePatch.utm_zone);
          }
        }

        const patchToGenerate =
          geometryToUse !== basePatch.geometry ? { ...basePatch, geometry: geometryToUse } : basePatch;

        // Step 1: Auto-copy model predictions as v1 reference data
        await autoCopyPredictionsAsReference(patchToGenerate);

        // Step 2: Generate nested patches
        await generateNestedPatchesRecursive(patchToGenerate);

        // Step 3: Mark base patch as validated (both layers)
        await updateLayerValidation({ patchId: basePatch.id, layer: "deadwood", validated: true });
        await updateLayerValidation({ patchId: basePatch.id, layer: "forest_cover", validated: true });
        onUnsavedChanges(true);

        message.success({ content: "Patches generated and reference data created!", key: "generate" });

        // Switch to 5cm resolution (skip 10cm QA - it will be auto-validated from 5cm children)
        setSelectedResolution(5);

        // Refetch patches to get updated reference label IDs
        await refetchPatches();

        // Small delay to allow React Query to update the patches list
        setTimeout(() => {
          // Auto-select first 5cm patch to start checking
          const firstChild = allPatches.find(
            (p) =>
              p.parent_tile_id !== null &&
              p.resolution_cm === 5 &&
              (p.deadwood_validated === null || p.forest_cover_validated === null),
          );
          if (firstChild) {
            setSelectedPatchId(firstChild.id);
          }
        }, 100);
      } catch (error) {
        console.error(error);
        message.error({ content: "Failed to generate patches", key: "generate" });
      }
    },
    [
      generateNestedPatchesRecursive,
      updateLayerValidation,
      onUnsavedChanges,
      allPatches,
      getPatchGeometryFromMap,
      autoCopyPredictionsAsReference,
      refetchPatches,
    ],
  );

  return (
    <div className="relative h-full w-full">
      {/* Completion Status Banner - floating at top center below header */}
      {isCompleted && (
        <div
          className={`absolute left-1/2 -translate-x-1/2 ${MAP_FLOATING_CHILD_TOP_CLASS} z-20 w-full max-w-2xl pointer-events-auto`}
        >
          <Alert
            message="Dataset Marked as Complete"
            description={
              <div className="flex items-center justify-between">
                <span>
                  This dataset has been marked as reference patches complete. To make changes, reopen it for editing.
                </span>
                <Button icon={<EditOutlined />} onClick={onReopenForEditing} size="small">
                  Reopen for Editing
                </Button>
              </div>
            }
            type="success"
            icon={<LockOutlined />}
            showIcon
            className="shadow-lg rounded-xl"
          />
        </div>
      )}

      {/* Map */}
      <div className="absolute inset-0 z-0">
        <ReferencePatchMap
          datasetId={dataset.id}
          cogPath={dataset.cog_path}
          resolution={selectedResolution}
          patches={patchesForResolution}
          onPatchSelected={handlePatchSelected}
          enableTranslation={true}
          focusPatchId={selectedPatchId}
          onGetPatchGeometry={handleGetPatchGeometry}
          onGetMapRef={handleGetMapRef}
          onGetOrthoLayer={handleGetOrthoLayer}
          layerSelection={layerSelection}
          selectedPatchId={selectedPatchId}
          selectedBasePatch={selectedBasePatch}
          isEditingMode={!!editingMode}
        />

        {/* Layer Radio Buttons (bottom-left) */}
        <LayerRadioButtons
          value={layerSelection}
          onChange={setLayerSelection}
          position="bottom-left"
          availableLayers={
            editingMode
              ? [editingMode === ILabelData.DEADWOOD ? "deadwood" : "forest_cover", "ortho_only"]
              : undefined
          }
        />

        {/* Editor Toolbar - shown during editing mode */}
        {editingMode && (
          <EditorToolbar
            type={editingMode}
            isDrawing={editor.isDrawing}
            hasSelection={!!editor.selection && editor.selection.length > 0}
            selectionCount={editor.selection?.length || 0}
            isAIActive={ai.isActive}
            isAIProcessing={ai.isProcessing}
            onToggleDraw={() => editor.toggleDraw()}
            onCutHole={editor.cutHoleWithDrawn}
            onMerge={editor.mergeSelected}
            onClip={editor.clipSelected}
            onToggleAI={() => (ai.isActive ? ai.disable() : ai.enable())}
            onDeleteSelected={editor.deleteSelected}
            onUndo={editor.undo}
            canUndo={editor.canUndo}
            onSave={handleSaveEdits}
            onCancel={handleCancelEditing}
            position="top-right"
            className={MAP_FLOATING_CHILD_TOP_CLASS}
          />
        )}

        {/* Add Base Patch Button (overlay) */}
        {!selectedPatch && !isCompleted && !editingMode && (
          <div className={`absolute left-4 ${MAP_FLOATING_CHILD_TOP_CLASS} z-10 pointer-events-auto`}>
            <Button
              icon={<PlusOutlined />}
              onClick={handleAddBasePatch}
              className="shadow-lg"
              disabled={hasBasePatch}
              title={hasBasePatch ? "This dataset already has a base patch." : undefined}
            >
              Add Base Patch
            </Button>
          </div>
        )}
      </div>

      {/* Sidebar (floating on the right) */}
      {selectedPatch && selectedBasePatch && !editingMode && (
        <div
          className={`absolute right-4 ${MAP_FLOATING_CHILD_TOP_CLASS} bottom-6 z-10 flex ${MAP_REFERENCE_SIDEBAR_WIDTH_CLASS} flex-col overflow-hidden rounded-2xl border border-gray-200/60 bg-white/95 shadow-xl backdrop-blur-sm pointer-events-auto`}
        >
          <PatchDetailSidebar
            basePatch={selectedBasePatch}
            selectedPatch={selectedPatch}
            selectedResolution={selectedResolution}
            allPatches={allPatches}
            onResolutionChange={setSelectedResolution}
            onPatchSelect={setSelectedPatchId}
            onStatusUpdate={async (patchId: number, status: "good" | "bad" | "pending") => {
              await updateStatus({ patchId, status });
              onUnsavedChanges(true);
            }}
            onLayerValidation={async (
              patchId: number,
              layer: "deadwood" | "forest_cover",
              validated: boolean | null,
            ) => {
              await updateLayerValidation({ patchId, layer, validated });
              onUnsavedChanges(true);
            }}
            currentLayer={layerSelection}
            onEditLayer={handleEditLayer}
            editButtonEnabled={layerSelection !== "ortho_only"}
            onDeselect={handleDeselect}
            batchProgress={batchProgress}
            onDelete={async (patchId: number) => {
              const patchToDelete = allPatches.find((p) => p.id === patchId);
              if (!patchToDelete) return;

              const basePatch = findBasePatchForPatch(patchToDelete, allPatches);
              if (!basePatch) return;

              const patchesToDelete: IReferencePatch[] = [basePatch];
              const children10cm = allPatches.filter((p) => p.parent_tile_id === basePatch.id);
              patchesToDelete.push(...children10cm);

              for (const child of children10cm) {
                const children5cm = allPatches.filter((p) => p.parent_tile_id === child.id);
                patchesToDelete.push(...children5cm);
              }

              const completionWarning = isCompleted
                ? "\n\n⚠️ Warning: Deleting patches will automatically reset this dataset's completion status. You'll need to mark it as complete again after making changes."
                : "";

              Modal.confirm({
                title: "Delete Entire Base Patch?",
                icon: <ExclamationCircleOutlined />,
                content: `This will delete the base patch and all ${patchesToDelete.length - 1} sub-patches.${completionWarning}`,
                okText: "Delete All",
                okType: "danger",
                cancelText: "Cancel",
                onOk: async () => {
                  message.loading({
                    content: `Deleting base patch and ${patchesToDelete.length - 1} sub-patches...`,
                    key: "delete",
                  });

                  await Promise.all(
                    patchesToDelete.map((patch) => deletePatch({ patchId: patch.id, datasetId: dataset.id })),
                  );

                  if (isCompleted) {
                    await onReopenForEditing();
                    message.success({
                      content: "Patches deleted and dataset reopened for editing",
                      key: "delete",
                    });
                  } else {
                    message.success({ content: "All patches deleted successfully!", key: "delete" });
                  }

                  setSelectedPatchId(null);
                  onUnsavedChanges(true);
                },
              });
            }}
            onGenerateSubPatches={handleGenerateSubPatches}
          />
        </div>
      )}
    </div>
  );
}
