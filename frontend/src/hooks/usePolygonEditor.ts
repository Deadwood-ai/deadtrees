import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Map from "ol/Map";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Draw, Modify, Select } from "ol/interaction";
import { click, shiftKeyOnly } from "ol/events/condition";
import Feature from "ol/Feature";
import Geometry from "ol/geom/Geometry";
import Polygon from "ol/geom/Polygon";
import MultiPolygon from "ol/geom/MultiPolygon";
import { Style, Fill, Stroke } from "ol/style";
import MapBrowserEvent from "ol/MapBrowserEvent";
import type { FeatureLike } from "ol/Feature";
import GeoJSON from "ol/format/GeoJSON";
import { union as geomUnion, difference as geomDifference } from "../utils/geometry";
import { message } from "antd";
import { palette } from "../theme/palette";

export interface UsePolygonEditorParams {
  mapRef: React.RefObject<Map | null>;
}

export interface UsePolygonEditorReturn {
  isEditing: boolean;
  startEditing: () => void;
  stopEditing: () => void;
  selection: Feature<Geometry>[];
  isDrawing: boolean;
  toggleDraw: (on?: boolean) => void;
  deleteSelected: () => void;
  clearAll: () => void;
  getOverlayLayer: () => VectorLayer<VectorSource> | null;
  setOverlayVisible: (visible: boolean) => void;
  mergeSelected: () => void;
  clipSelected: () => void;
  cutHoleWithDrawn: () => void;
  undo: () => void;
  canUndo: boolean;
  saveHistorySnapshot: () => void; // Exposed for AI segmentation
}

export default function usePolygonEditor({ mapRef }: UsePolygonEditorParams): UsePolygonEditorReturn {
  const [isEditing, setIsEditing] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [selection, setSelection] = useState<Feature<Geometry>[]>([]);
  const [canUndo, setCanUndo] = useState(false);

  // History stack for undo (max 20 actions)
  const historyRef = useRef<string[]>([]); // Store GeoJSON strings of feature collections
  const MAX_HISTORY = 20;

  const overlayLayerRef = useRef<VectorLayer<VectorSource<Feature<Geometry>>> | null>(null);
  const selectRef = useRef<Select | null>(null);
  const modifyRef = useRef<Modify | null>(null);
  const drawRef = useRef<Draw | null>(null);
  const hoveredFeatureRef = useRef<Feature<Geometry> | null>(null);
  const pointerMoveListenerRef = useRef<((evt: MapBrowserEvent<UIEvent>) => void) | null>(null);
  const clickListenerRef = useRef<((evt: MapBrowserEvent<UIEvent>) => void) | null>(null);

  const ensureOverlay = useCallback(() => {
    if (!mapRef.current) return;
    if (overlayLayerRef.current) return;

    const source = new VectorSource<Feature<Geometry>>({ wrapX: false } as unknown as { wrapX: boolean });

    // Style function that determines appearance based on feature state and correction status
    // - Original/Prediction: Default fill with thin gray border (no special border)
    // - Edited/Pending (is_new, is_modified, or correction_status='pending'): Blue border
    // - Approved (correction_status='approved'): Green border
    // - Selected/Hovered states override base styling
    const styleFunction = (feature: FeatureLike) => {
      const isSelected = feature.get("dt_selected") === true;
      const isHovered = feature.get("dt_hovered") === true;
      const isNew = feature.get("is_new") === true;
      const isModified = feature.get("is_modified") === true;
      const correctionStatus = feature.get("correction_status") as string | null;

      // Determine if this feature has been edited (locally or from DB)
      const hasEdits = isNew || isModified || correctionStatus === "pending";
      const isApproved = correctionStatus === "approved";

      // Fill color - high contrast for bright/dark canopy backgrounds
      const fillColor = "rgba(0, 200, 255, 0.14)"; // light cyan @ 14%

      // Determine stroke color based on correction state
      let strokeColor: string;
      let strokeWidth: number;

      if (isSelected) {
        // Selected: Orange, thick stroke (interaction state takes priority)
        strokeColor = palette.state.selected;
        strokeWidth = 4;
      } else if (isHovered) {
        // Hover: Cyan, medium stroke (interaction state takes priority)
        strokeColor = palette.state.hover;
        strokeWidth = 3;
      } else if (isApproved) {
        // Approved/Verified: Green border
        strokeColor = palette.forest[600];
        strokeWidth = 2;
      } else if (hasEdits) {
        // Edited/Pending: Blue border
        strokeColor = palette.primary[500];
        strokeWidth = 2;
      } else {
        // Original/Prediction: Cyan border for better contrast in editing mode
        strokeColor = "#00C8FF";
        strokeWidth = 2.5;
      }

      return new Style({
        fill: new Fill({ color: fillColor }),
        stroke: new Stroke({ color: strokeColor, width: strokeWidth }),
      });
    };

    const layer = new VectorLayer({
      source: source as unknown as VectorSource,
      style: styleFunction,
      updateWhileAnimating: false,
      updateWhileInteracting: false,
    });

    try {
      layer.setVisible(true);
      layer.setZIndex(2000);
    } catch (e) {
      // ignore
    }

    mapRef.current.addLayer(layer);
    overlayLayerRef.current = layer as unknown as VectorLayer<VectorSource<Feature<Geometry>>>;
  }, [mapRef]);

  // Save current state to history before modifications
  const saveHistory = useCallback(() => {
    const overlay = overlayLayerRef.current;
    if (!overlay) return;
    const source = overlay.getSource();
    if (!source) return;

    const features = source.getFeatures();
    const geoJsonFormatter = new GeoJSON();

    // Serialize all features to GeoJSON (excluding temporary features like AI bbox)
    // IMPORTANT: preserve all metadata needed for save diffing (geometry_id, updated_at, etc.)
    const featuresGeoJSON = features
      .filter((f) => {
        // Exclude temporary features (like AI segmentation bbox)
        const role = f.get("dt_role");
        return role !== "bbox";
      })
      .map((f) => {
        const geomGeoJSON = geoJsonFormatter.writeGeometryObject(f.getGeometry()!, {
          dataProjection: "EPSG:3857",
          featureProjection: "EPSG:3857",
        });
        return {
          geometry: geomGeoJSON,
          properties: {
            label_data: f.get("label_data"),
            patch_id: f.get("patch_id"),
            geometry_id: f.get("geometry_id") ?? null,
            updated_at: f.get("updated_at") ?? null,
            is_new: f.get("is_new") ?? false,
            is_modified: f.get("is_modified") ?? false,
            replaces_geometry_id: f.get("replaces_geometry_id") ?? null,
          },
        };
      });

    const snapshot = JSON.stringify(featuresGeoJSON);

    // Add to history (limit to MAX_HISTORY)
    historyRef.current.push(snapshot);
    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current.shift(); // Remove oldest
    }

    setCanUndo(true);
  }, [MAX_HISTORY]);

  // Undo last operation
  const undo = useCallback(() => {
    if (historyRef.current.length === 0) return;

    const overlay = overlayLayerRef.current;
    if (!overlay) return;
    const source = overlay.getSource();
    if (!source) return;

    // Pop last snapshot from history
    const snapshot = historyRef.current.pop();
    if (!snapshot) return;

    // Restore features from snapshot
    const featuresData = JSON.parse(snapshot);
    const geoJsonFormatter = new GeoJSON();

    // Clear current features
    source.clear();

    // Restore features with all preserved metadata
    featuresData.forEach((featureData: { geometry: unknown; properties: Record<string, unknown> }) => {
      const geometry = geoJsonFormatter.readGeometry(featureData.geometry, {
        dataProjection: "EPSG:3857",
        featureProjection: "EPSG:3857",
      });
      const feature = new Feature(geometry);
      feature.set("label_data", featureData.properties.label_data);
      feature.set("patch_id", featureData.properties.patch_id);
      if (featureData.properties.geometry_id) feature.set("geometry_id", featureData.properties.geometry_id);
      if (featureData.properties.updated_at) feature.set("updated_at", featureData.properties.updated_at);
      if (featureData.properties.is_new) feature.set("is_new", featureData.properties.is_new);
      if (featureData.properties.is_modified) feature.set("is_modified", featureData.properties.is_modified);
      if (featureData.properties.replaces_geometry_id) feature.set("replaces_geometry_id", featureData.properties.replaces_geometry_id);
      source.addFeature(feature);
    });

    // Clear selection
    if (selectRef.current) {
      selectRef.current.getFeatures().clear();
    }
    setSelection([]);

    // Update canUndo state
    setCanUndo(historyRef.current.length > 0);

    message.success("Undo successful");
  }, []);

  const startEditing = useCallback(() => {
    console.debug("[usePolygonEditor] startEditing called, mapRef.current:", !!mapRef.current, "isEditing:", isEditing);
    if (!mapRef.current || isEditing) {
      console.debug("[usePolygonEditor] Returning early from startEditing");
      return;
    }

    console.debug("[usePolygonEditor] Ensuring overlay...");
    ensureOverlay();
    const overlay = overlayLayerRef.current!;
    console.debug("[usePolygonEditor] Overlay layer:", !!overlay);

    // Select interaction limited to overlay layer
    // Use null style - styling handled by layer's style function
    // Note: We use basic click condition and handle multi-select logic manually
    const select = new Select({
      layers: [overlay],
      style: null, // Don't apply custom style, use layer's style function
      multi: false, // We'll handle multi-select manually
      condition: click, // Always trigger on click
    });
    mapRef.current.addInteraction(select);
    selectRef.current = select;

    // Track selection changes and update feature properties
    const selectedCollection = select.getFeatures();

    // Custom selection logic to implement:
    // 1. Click on polygon -> single selection (clear previous)
    // 2. Click on selected polygon -> deselect it
    // 3. Shift+click -> additive selection (max 2)
    select.on("select", (evt) => {
      const clickedFeature = evt.selected.length > 0 ? evt.selected[0] : null;
      const wasSelected = evt.deselected.length > 0 ? evt.deselected[0] : null;
      const shiftKey = evt.mapBrowserEvent.originalEvent.shiftKey;
      const currentSelection = selectedCollection.getArray();

      console.debug("[Selection] Click event:", {
        clickedFeature: !!clickedFeature,
        wasSelected: !!wasSelected,
        shiftKey,
        currentSelectionCount: currentSelection.length,
      });

      // Behavior 1: Clicking selected feature -> deselect it
      if (wasSelected && !clickedFeature) {
        // OpenLayers already removed it, we're good
        console.debug("[Selection] Deselected feature");
        return;
      }

      // Behavior 2: Shift+click -> additive selection (max 2)
      if (shiftKey && clickedFeature) {
        // Check if we already have this feature (shouldn't happen with OL, but safe check)
        if (currentSelection.includes(clickedFeature)) {
          console.debug("[Selection] Feature already selected");
          return;
        }

        // If we have 2+ features, remove the oldest ones
        while (currentSelection.length > 2) {
          const toRemove = currentSelection[0];
          selectedCollection.remove(toRemove);
          console.debug("[Selection] Removed oldest to maintain max 2");
        }

        console.debug("[Selection] Added to selection (Shift), total:", currentSelection.length);
        return;
      }

      // Behavior 3: Click without Shift -> single selection (clear others)
      if (!shiftKey && clickedFeature) {
        // Clear all other selections, keep only clicked
        const otherFeatures = currentSelection.filter((f) => f !== clickedFeature);
        otherFeatures.forEach((f) => selectedCollection.remove(f));

        // Ensure clicked feature is in selection
        if (!currentSelection.includes(clickedFeature)) {
          selectedCollection.push(clickedFeature);
        }

        console.debug("[Selection] Single select (no Shift)");
        return;
      }
    });

    // Modify interaction, active only when selection exists
    const modify = new Modify({ features: selectedCollection });
    modify.setActive(selectedCollection.getLength() > 0);
    mapRef.current.addInteraction(modify);
    modifyRef.current = modify;

    // Save history before modification starts
    modify.on("modifystart", () => {
      saveHistory();
    });

    // Unified selection update handler - updates both React state and modify interaction
    const updateSelection = () => {
      const allFeatures = overlay.getSource()?.getFeatures() || [];
      const selectedFeatures = selectedCollection.getArray() as Feature<Geometry>[];

      // Update dt_selected property on all features for visual feedback
      allFeatures.forEach((f) => {
        f.set("dt_selected", selectedFeatures.includes(f));
      });

      // Update modify interaction active state
      modify.setActive(selectedFeatures.length > 0);

      // Update React state - THIS is what drives the toolbar
      setSelection([...selectedFeatures]); // Create new array to ensure React detects change

      console.debug("[Selection] Updated:", {
        count: selectedFeatures.length,
        featureIds: selectedFeatures.map((f) => f.getId() || f.get("id") || "unknown"),
      });
    };

    // Listen to selection changes
    selectedCollection.on(["add", "remove"], updateSelection);

    // If a feature becomes selected, clear any hover state
    selectedCollection.on(["add"], () => {
      if (hoveredFeatureRef.current) {
        hoveredFeatureRef.current.set("dt_hovered", false);
        hoveredFeatureRef.current = null;
      }
    });

    // Hover highlight handler - use feature properties instead of setStyle
    const handlePointerMove = (evt: MapBrowserEvent<UIEvent>) => {
      if (!mapRef.current || !overlayLayerRef.current) return;
      let hitFeature: Feature<Geometry> | null = null;
      mapRef.current.forEachFeatureAtPixel(
        evt.pixel,
        (f, layer) => {
          if (layer === overlayLayerRef.current) {
            // Ignore temporary bbox features from AI segmentation
            try {
              if ((f as Feature<Geometry>).get && (f as Feature<Geometry>).get("dt_role") === "bbox") {
                return false;
              }
            } catch (e) {
              // ignore
            }
            hitFeature = f as Feature<Geometry>;
            return true;
          }
          return false;
        },
        { hitTolerance: 4 },
      );
      // Do not apply hover style for selected features
      if (hitFeature && selectedCollection.getArray().includes(hitFeature as unknown as Feature<Geometry>)) {
        hitFeature = null;
      }

      // Clear hover state from previous feature
      if (hoveredFeatureRef.current && hoveredFeatureRef.current !== hitFeature) {
        hoveredFeatureRef.current.set("dt_hovered", false);
        hoveredFeatureRef.current = null;
      }

      // Set hover state on new feature
      if (hitFeature && hoveredFeatureRef.current !== hitFeature) {
        hoveredFeatureRef.current = hitFeature as Feature<Geometry>;
        (hitFeature as Feature<Geometry>).set("dt_hovered", true);
      }
    };
    mapRef.current.on("pointermove", handlePointerMove);
    pointerMoveListenerRef.current = handlePointerMove;

    // Click outside to clear selection (keeps toolbar in sync)
    const handleMapClick = (evt: MapBrowserEvent<UIEvent>) => {
      if (!mapRef.current || !overlayLayerRef.current || !selectRef.current) return;
      // If drawing, ignore (draw handles clicks)
      if (drawRef.current) return;

      let hitOverlay = false;
      mapRef.current.forEachFeatureAtPixel(
        evt.pixel,
        (_f, layer) => {
          if (layer === overlayLayerRef.current) {
            hitOverlay = true;
            return true;
          }
          return false;
        },
        { hitTolerance: 4 },
      );

      if (!hitOverlay) {
        const coll = selectRef.current.getFeatures();
        if (coll.getLength() > 0) {
          // Clear dt_selected from all features
          const allFeatures = overlayLayerRef.current?.getSource()?.getFeatures() || [];
          allFeatures.forEach((f) => f.set("dt_selected", false));

          coll.clear();
          setSelection([]);
          if (modifyRef.current) modifyRef.current.setActive(false);
          if (hoveredFeatureRef.current) {
            hoveredFeatureRef.current.set("dt_hovered", false);
            hoveredFeatureRef.current = null;
          }
        }
      }
    };
    mapRef.current.on("click", handleMapClick);
    clickListenerRef.current = handleMapClick;

    // Draw interaction created lazily on toggle
    setIsEditing(true);
    console.debug("[usePolygonEditor] startEditing completed, interactions added");
  }, [ensureOverlay, isEditing, mapRef, saveHistory]);

  const stopEditing = useCallback(() => {
    if (!mapRef.current || !isEditing) return;

    // Remove interactions
    if (drawRef.current) {
      mapRef.current.removeInteraction(drawRef.current);
      drawRef.current = null;
    }
    if (modifyRef.current) {
      mapRef.current.removeInteraction(modifyRef.current);
      modifyRef.current = null;
    }
    if (selectRef.current) {
      mapRef.current.removeInteraction(selectRef.current);
      selectRef.current = null;
    }

    // Clear history (fresh start for next editing session)
    historyRef.current = [];
    setCanUndo(false);

    // Keep overlay for now; page unmount clears it. Clear selection/draw flags
    setSelection([]);
    setIsDrawing(false);
    setIsEditing(false);

    // Remove hover handler and reset hovered style
    if (pointerMoveListenerRef.current && mapRef.current) {
      mapRef.current.un("pointermove", pointerMoveListenerRef.current);
      pointerMoveListenerRef.current = null;
    }
    if (clickListenerRef.current && mapRef.current) {
      mapRef.current.un("click", clickListenerRef.current);
      clickListenerRef.current = null;
    }
    if (hoveredFeatureRef.current) {
      hoveredFeatureRef.current.set("dt_hovered", false);
      hoveredFeatureRef.current = null;
    }
    // Clear overlay features on exit to restore base layer visibility via listeners upstream
    if (overlayLayerRef.current) {
      const src = overlayLayerRef.current.getSource() as VectorSource<Feature<Geometry>> | null;
      src?.clear();
    }
  }, [isEditing, mapRef]);

  const toggleDraw = useCallback(
    (on?: boolean) => {
      console.debug("[usePolygonEditor] toggleDraw called, mapRef.current:", !!mapRef.current, "isDrawing:", isDrawing);
      if (!mapRef.current) {
        console.debug("[usePolygonEditor] No map ref, returning");
        return;
      }
      ensureOverlay();

      const shouldEnable = typeof on === "boolean" ? on : !isDrawing;
      console.debug("[usePolygonEditor] shouldEnable:", shouldEnable);
      if (shouldEnable) {
        if (drawRef.current) {
          console.debug("[usePolygonEditor] Draw already active, returning");
          return;
        }
        const overlay = overlayLayerRef.current!;
        const source = overlay.getSource() as VectorSource<Feature<Geometry>> | null;
        console.debug("[usePolygonEditor] Creating draw interaction, overlay:", !!overlay, "source:", !!source);

        // Style for the sketch (polygon being drawn) - very visible
        const sketchStyle = new Style({
          fill: new Fill({ color: "rgba(255, 200, 0, 0.05)" }), // Bright yellow-orange @ 60% - highly visible for labeling
          stroke: new Stroke({ color: palette.state.selected, width: 4 }), // Orange, thick stroke
        });

        const draw = new Draw({
          source: (source as unknown as VectorSource)!,
          type: "Polygon",
          freehand: false, // Standard click-to-draw by defaulta
          freehandCondition: shiftKeyOnly, // Enable freehand when Shift is held
          style: sketchStyle, // Apply bright style to sketch
        });
        mapRef.current.addInteraction(draw);
        drawRef.current = draw;
        setIsDrawing(true);
        console.debug("[usePolygonEditor] Draw interaction added to map");

        // Save history when drawing starts (before new feature is added)
        draw.once("drawstart", () => {
          saveHistory();
        });

        // Auto-exit draw mode after polygon completion
        draw.once("drawend", (evt) => {
          const drawnFeature = evt.feature as Feature<Geometry> | undefined;
          if (drawnFeature) {
            drawnFeature.set("is_new", true);
          }

          // IMPORTANT: defer interaction removal to the next microtask.
          // Calling removeInteraction() during drawend triggers OL's
          // updateState_() → abortDrawing() which races with finishDrawing()
          // adding the feature to the source, leaving the layer stale on
          // some browsers.
          const drawToRemove = drawRef.current;
          drawRef.current = null;

          queueMicrotask(() => {
            if (mapRef.current && drawToRemove) {
              mapRef.current.removeInteraction(drawToRemove);
            }
            setIsDrawing(false);

            // Ensure the drawn feature is on the overlay source (safety net)
            const src = overlayLayerRef.current?.getSource();
            if (drawnFeature && src && !src.getFeatures().includes(drawnFeature)) {
              src.addFeature(drawnFeature);
            }
            src?.changed();
          });
        });
      } else {
        if (!drawRef.current) return;
        mapRef.current.removeInteraction(drawRef.current);
        drawRef.current = null;
        setIsDrawing(false);
        console.debug("[usePolygonEditor] Draw interaction removed from map");
      }
    },
    [ensureOverlay, isDrawing, mapRef, saveHistory],
  );

  const deleteSelected = useCallback(() => {
    const overlay = overlayLayerRef.current;
    const select = selectRef.current;
    if (!overlay || !select) return;
    const source = overlay.getSource() as VectorSource<Feature<Geometry>> | null;
    if (!source) return;

    // Save history before deleting
    saveHistory();

    const featuresToDelete = [...(select.getFeatures().getArray() as Feature<Geometry>[])];
    featuresToDelete.forEach((f) => source.removeFeature(f));
    select.getFeatures().clear();
    setSelection([]);
  }, [saveHistory]);

  const mergeSelected = useCallback(() => {
    const overlay = overlayLayerRef.current;
    const select = selectRef.current;
    if (!overlay || !select) return;
    const source = overlay.getSource() as VectorSource<Feature<Geometry>> | null;
    if (!source) return;
    const selected = select.getFeatures().getArray() as Feature<Geometry>[];
    if (selected.length !== 2) {
      message.warning("Select exactly two polygons to merge.");
      return;
    }
    const [a, b] = selected;
    const ga = a.getGeometry();
    const gb = b.getGeometry();
    if (!ga || !gb) return;

    // Save history before merging
    saveHistory();

    // Union handles all cases: intersecting, containing, or separate polygons
    const merged = geomUnion(ga, gb);
    if (!merged) {
      message.error("Failed to merge polygons.");
      return;
    }
    // keep id from first feature, mark as modified for save detection
    const originalGeometryId = a.get("geometry_id");
    a.setGeometry(merged);
    a.set("is_modified", true);
    // Set replaces_geometry_id so backend knows to soft-delete the original
    if (originalGeometryId) {
      a.set("replaces_geometry_id", originalGeometryId);
    }
    source.removeFeature(b);
    select.getFeatures().clear();
    select.getFeatures().push(a);
    setSelection([a]);
  }, [saveHistory]);

  const clipSelected = useCallback(() => {
    const overlay = overlayLayerRef.current;
    const select = selectRef.current;
    if (!overlay || !select) return;
    const source = overlay.getSource() as VectorSource<Feature<Geometry>> | null;
    if (!source) return;
    const selected = select.getFeatures().getArray() as Feature<Geometry>[];
    if (selected.length !== 2) {
      message.warning("Select exactly two polygons to clip.");
      return;
    }
    const [a, b] = selected;
    const ga = a.getGeometry();
    const gb = b.getGeometry();
    if (!ga || !gb) return;

    console.debug("=== CLIP OPERATION DEBUG ===");

    // Save history before clipping
    saveHistory();

    // Calculate areas to determine which is larger (in map projection units)
    // Both Polygon and MultiPolygon have getArea() method
    const areaA = ga instanceof Polygon || ga instanceof MultiPolygon ? ga.getArea() : 0;
    const areaB = gb instanceof Polygon || gb instanceof MultiPolygon ? gb.getArea() : 0;

    console.debug("Polygon A:", {
      type: ga.getType(),
      area: areaA.toFixed(2),
    });
    console.debug("Polygon B:", {
      type: gb.getType(),
      area: areaB.toFixed(2),
    });

    // Determine which is larger and which is smaller
    let larger, smaller, largerFeature, smallerFeature;
    if (areaA >= areaB) {
      larger = ga;
      smaller = gb;
      largerFeature = a;
      smallerFeature = b;
      console.debug("A is larger (area: " + areaA.toFixed(2) + ") - will keep A, remove B");
    } else {
      larger = gb;
      smaller = ga;
      largerFeature = b;
      smallerFeature = a;
      console.debug("B is larger (area: " + areaB.toFixed(2) + ") - will keep B, remove A");
    }

    // Subtract smaller polygon from larger polygon
    console.debug("Calling geomDifference(larger, smaller)...");
    const clipped = geomDifference(larger, smaller);
    console.debug("geomDifference result:", clipped);

    if (!clipped) {
      console.error("geomDifference returned null/undefined - polygons may not overlap");
      message.error("Failed to clip polygons. They may not overlap.");
      console.debug("=== END CLIP OPERATION DEBUG (FAILED) ===");
      return;
    }

    console.debug("Clipped geometry:", {
      type: clipped.getType(),
      area: (clipped instanceof Polygon || clipped instanceof MultiPolygon ? clipped.getArea() : 0).toFixed(2),
    });

    // Update the larger polygon with clipped result, remove the smaller polygon
    console.debug("Setting clipped geometry on larger feature and removing smaller feature");
    const originalGeometryId = largerFeature.get("geometry_id");
    largerFeature.setGeometry(clipped);
    largerFeature.set("is_modified", true);
    // Set replaces_geometry_id so backend knows to soft-delete the original
    if (originalGeometryId) {
      largerFeature.set("replaces_geometry_id", originalGeometryId);
    }
    source.removeFeature(smallerFeature);
    select.getFeatures().clear();
    select.getFeatures().push(largerFeature);
    setSelection([largerFeature]);
    message.success("Smaller polygon clipped from larger polygon");
    console.debug("=== END CLIP OPERATION DEBUG (SUCCESS) ===");
  }, [saveHistory]);

  // Cut hole / trim edges: user draws a polygon, then we subtract from single selected feature
  const cutHoleWithDrawn = useCallback(() => {
    if (!mapRef.current) return;
    ensureOverlay();
    const select = selectRef.current;
    if (!select) return;
    const selected = select.getFeatures().getArray() as Feature<Geometry>[];
    if (selected.length !== 1) {
      message.warning("Select a single polygon, then draw a shape to cut out or trim.");
      return;
    }
    const target = selected[0];
    const targetGeom = target.getGeometry();
    if (!targetGeom) return;

    // temporary draw for the hole/trim polygon
    if (drawRef.current) {
      mapRef.current.removeInteraction(drawRef.current);
      drawRef.current = null;
    }
    // Use a temporary in-memory source that is NOT the overlay
    const tempSource = new VectorSource<Feature<Geometry>>();

    // Style for the sketch (polygon being drawn) - very visible
    const sketchStyle = new Style({
      fill: new Fill({ color: "rgba(255, 200, 0, 0.6)" }), // Bright yellow-orange @ 60% - highly visible for labeling
      stroke: new Stroke({ color: palette.state.selected, width: 4 }), // Orange, thick stroke
    });

    const draw = new Draw({
      source: tempSource as unknown as VectorSource,
      type: "Polygon",
      freehand: false, // Standard click-to-draw by default
      freehandCondition: shiftKeyOnly, // Enable freehand when Shift is held
      style: sketchStyle, // Apply bright style to sketch
    });
    mapRef.current.addInteraction(draw);
    drawRef.current = draw;
    setIsDrawing(true);

    draw.once("drawend", (evt) => {
      const cutFeature = evt.feature as Feature<Geometry>;
      const cutGeom = cutFeature.getGeometry();
      if (cutGeom) {
        console.debug("=== CUT OPERATION DEBUG ===");
        console.debug("Target geometry:", {
          type: targetGeom.getType(),
          area: targetGeom instanceof Polygon || targetGeom instanceof MultiPolygon ? targetGeom.getArea() : 0,
        });
        console.debug("Cut geometry:", {
          type: cutGeom.getType(),
          area: cutGeom instanceof Polygon || cutGeom instanceof MultiPolygon ? cutGeom.getArea() : 0,
        });

        // Save history before cutting
        saveHistory();

        // Perform difference operation - works for holes, edge trimming, and no-ops if no overlap
        console.debug("Calling geomDifference(target, cut)...");
        const diff = geomDifference(targetGeom, cutGeom);
        console.debug("geomDifference result:", diff);

        if (!diff) {
          console.error("geomDifference returned null/undefined - polygon would be empty");
          message.error("Failed to cut polygon. Result would be empty.");
          console.debug("=== END CUT OPERATION DEBUG (FAILED) ===");
        } else {
          console.debug("Result geometry:", {
            type: diff.getType(),
            area: diff instanceof Polygon || diff instanceof MultiPolygon ? diff.getArea() : 0,
          });

          const overlay = overlayLayerRef.current;
          const source = overlay?.getSource() as VectorSource<Feature<Geometry>> | null;

          // Check if result is a MultiPolygon (polygon was split into multiple pieces)
          if (diff.getType() === "MultiPolygon" && source) {
            console.debug("Result is MultiPolygon - splitting into separate features");
            // Split into separate Polygon features
            const newFeatures: Feature<Geometry>[] = [];
            const multiPolygon = diff as MultiPolygon;
            const polygons = multiPolygon.getPolygons();

            polygons.forEach((polygon) => {
              const newFeature = new Feature({
                geometry: polygon,
              });

              // Copy properties from original feature
              newFeature.set("label_data", target.get("label_data"));
              newFeature.set("patch_id", target.get("patch_id"));

              newFeatures.push(newFeature);
            });

            // Remove original feature
            source.removeFeature(target);

            // Mark all new features as new (for save detection)
            newFeatures.forEach((f) => f.set("is_new", true));

            // Add all new features
            source.addFeatures(newFeatures);

            // Update selection to include all new features
            if (selectRef.current) {
              const selectedCollection = selectRef.current.getFeatures();
              selectedCollection.clear();
              newFeatures.forEach((f) => selectedCollection.push(f));

              // Update selection state and feature properties
              newFeatures.forEach((f) => f.set("dt_selected", true));
              setSelection(newFeatures);
            }

            message.success(`Polygon split into ${newFeatures.length} separate pieces!`);
            console.debug("=== END CUT OPERATION DEBUG (SUCCESS - MultiPolygon) ===");
          } else {
          // Single polygon result - update original feature
          console.debug("Single Polygon result - updating original feature");
          const originalGeometryId = target.get("geometry_id");
          target.setGeometry(diff);
          target.set("is_modified", true);
          // Set replaces_geometry_id so backend knows to soft-delete the original
          // and create the modified version (prevents dual-layer issue)
          if (originalGeometryId) {
            target.set("replaces_geometry_id", originalGeometryId);
          }
          message.success("Polygon cut successfully!");
            console.debug("=== END CUT OPERATION DEBUG (SUCCESS - Polygon) ===");
          }

          // Clear temp source; cut feature was never added to overlay
          tempSource.clear();
        }
      } else {
        console.debug("=== END CUT OPERATION DEBUG (No cutGeom) ===");
      }
      if (drawRef.current) {
        mapRef.current?.removeInteraction(drawRef.current);
        drawRef.current = null;
      }
      setIsDrawing(false);
    });
  }, [ensureOverlay, mapRef, saveHistory]);

  const clearAll = useCallback(() => {
    const overlay = overlayLayerRef.current;
    if (!overlay) return;
    const source = overlay.getSource() as VectorSource<Feature<Geometry>> | null;
    // Remove edited ids from hidden set stored on overlay layer for unmasking
    try {
      const layerAny = overlay as unknown as { __hiddenIds?: Set<string | number> };
      if (layerAny.__hiddenIds) layerAny.__hiddenIds.clear();
    } catch (e) {
      // ignore
    }
    source?.clear();
    if (selectRef.current) selectRef.current.getFeatures().clear();
    setSelection([]);
  }, []);

  const setOverlayVisible = useCallback((visible: boolean) => {
    const overlay = overlayLayerRef.current;
    if (!overlay) return;
    overlay.setVisible(visible);
  }, []);

  // Cleanup overlay layer on unmount
  useEffect(() => {
    const map = mapRef.current;
    return () => {
      if (!map) return;
      if (pointerMoveListenerRef.current) {
        map.un("pointermove", pointerMoveListenerRef.current);
        pointerMoveListenerRef.current = null;
      }
      if (clickListenerRef.current) {
        map.un("click", clickListenerRef.current);
        clickListenerRef.current = null;
      }
      if (drawRef.current) map.removeInteraction(drawRef.current);
      if (modifyRef.current) map.removeInteraction(modifyRef.current);
      if (selectRef.current) map.removeInteraction(selectRef.current);
      if (overlayLayerRef.current) {
        try {
          map.removeLayer(overlayLayerRef.current);
        } catch (e) {
          // ignore
        }
        overlayLayerRef.current = null;
      }
    };
  }, [mapRef]);

  return useMemo(
    () => ({
      isEditing,
      startEditing,
      stopEditing,
      selection,
      isDrawing,
      toggleDraw,
      deleteSelected,
      clearAll,
      getOverlayLayer: () => {
        const layer = (overlayLayerRef.current as unknown as VectorLayer<VectorSource>) || null;
        console.debug("[Editor] getOverlayLayer called, layer =", !!layer, "source =", !!layer?.getSource());
        return layer;
      },
      setOverlayVisible,
      mergeSelected,
      clipSelected,
      cutHoleWithDrawn,
      undo,
      canUndo,
      saveHistorySnapshot: saveHistory,
    }),
    [
      clearAll,
      deleteSelected,
      isDrawing,
      isEditing,
      selection,
      startEditing,
      stopEditing,
      toggleDraw,
      setOverlayVisible,
      mergeSelected,
      clipSelected,
      cutHoleWithDrawn,
      undo,
      canUndo,
      saveHistory,
    ],
  );
}
