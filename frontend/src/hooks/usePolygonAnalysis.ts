/**
 * Hook that encapsulates all polygon-drawing analysis logic:
 * drawing interaction, live area overlay, area validation, and stats fetching.
 *
 * Usage in a map component:
 *   const polygon = usePolygonAnalysis(mapRef);
 *   // polygon.isDrawing      – pass to click-guard & control panel
 *   // polygon.toggle()       – wire to the "Analyse Area" button
 *   // polygon.modalProps     – spread onto <PolygonStatsModal />
 */
import { useState, useRef, useCallback } from "react";
import { Overlay } from "ol";
import type { Map } from "ol";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import { Polygon } from "ol/geom";
import { Draw } from "ol/interaction";
import { Style, Fill, Stroke, Circle as CircleStyle } from "ol/style";
import { toLonLat } from "ol/proj";
import * as turf from "@turf/turf";
import { message } from "antd";
import { palette } from "../theme/palette";
import { usePolygonStats } from "./usePolygonStats";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const MAX_STATS_AREA_KM2 = 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Colour scheme for the drawing overlay based on how close to the limit. */
function getAreaColor(areaKm2: number): {
  bg: string;
  text: string;
  strokeColor: string;
  fillColor: string;
} {
  const ratio = areaKm2 / MAX_STATS_AREA_KM2;
  if (ratio > 1) {
    return {
      bg: palette.state.error,
      text: "#fff",
      strokeColor: palette.state.error,
      fillColor: "rgba(239, 68, 68, 0.15)",
    };
  }
  if (ratio > 0.8) {
    return {
      bg: palette.state.warning,
      text: "#000",
      strokeColor: palette.state.warning,
      fillColor: "rgba(217, 164, 65, 0.12)",
    };
  }
  return {
    bg: palette.forest[500],
    text: "#fff",
    strokeColor: palette.forest[500],
    fillColor: "rgba(41, 210, 128, 0.12)",
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePolygonAnalysis(mapRef: React.MutableRefObject<Map | null>) {
  // ---- state ----
  const [isDrawing, setIsDrawing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [canFinish, setCanFinish] = useState(false);

  // ---- refs (not in React state to avoid re-renders) ----
  const drawRef = useRef<Draw | null>(null);
  const layerRef = useRef<VectorLayer<VectorSource<Feature<Polygon>>> | null>(
    null,
  );
  const overlayRef = useRef<Overlay | null>(null);
  const areaKm2Ref = useRef<number>(0);

  const stats = usePolygonStats();

  // ---- overlay management ----

  /** Lazily create the area-badge overlay the first time we need it. */
  const ensureOverlay = useCallback(() => {
    const map = mapRef.current;
    if (!map || overlayRef.current) return;

    const el = document.createElement("div");
    el.id = "polygon-area-badge";
    el.style.cssText =
      "display:none; padding: 4px 10px; border-radius: 20px; font-size: 12px; " +
      "font-weight: 600; font-family: system-ui, sans-serif; white-space: nowrap; " +
      "pointer-events: none; box-shadow: 0 2px 6px rgba(0,0,0,0.2); " +
      "transition: background 0.2s, color 0.2s;";

    const overlay = new Overlay({
      element: el,
      positioning: "bottom-center",
      offset: [0, -16],
    });
    map.addOverlay(overlay);
    overlayRef.current = overlay;
  }, [mapRef]);

  /** Update the content / position of the area-badge overlay. */
  const updateOverlay = useCallback(
    (areaKm2: number, position: number[] | undefined) => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const el = overlay.getElement() as HTMLDivElement | null;
      if (!el) return;

      if (areaKm2 <= 0 || !position) {
        el.style.display = "none";
        overlay.setPosition(undefined);
        return;
      }

      const { bg, text } = getAreaColor(areaKm2);
      const overLimit = areaKm2 > MAX_STATS_AREA_KM2;
      const formatted =
        areaKm2 >= 1
          ? `${areaKm2.toFixed(1)} km²`
          : `${(areaKm2 * 1_000_000).toFixed(0)} m²`;

      el.innerHTML = overLimit ? `${formatted} — too large` : formatted;
      el.style.background = bg;
      el.style.color = text;
      el.style.display = "block";
      overlay.setPosition(position);
    },
    [],
  );

  // ---- drawing lifecycle ----

  const resetDrawingState = useCallback(() => {
    areaKm2Ref.current = 0;
    updateOverlay(0, undefined);
    setCanFinish(false);
  }, [updateOverlay]);

  const removeDrawInteraction = useCallback(
    (drawToRemove: Draw | null, defer = false) => {
      const cleanup = () => {
        const map = mapRef.current;
        if (map && drawToRemove) {
          map.removeInteraction(drawToRemove);
        }
        if (map) {
          const el = map.getTargetElement();
          if (el) el.style.cursor = "";
        }
        drawRef.current = null;
        setIsDrawing(false);
        setCanFinish(false);
      };

      if (defer) {
        queueMicrotask(cleanup);
      } else {
        cleanup();
      }
    },
    [mapRef],
  );

  const startDrawing = useCallback(() => {
    const map = mapRef.current;
    if (!map || isDrawing) return;

    const mapElement = map.getTargetElement();
    if (mapElement) mapElement.style.cursor = "crosshair";

    ensureOverlay();
    resetDrawingState();

    // Create / reuse the vector layer for the finished polygon
    if (!layerRef.current) {
      const source = new VectorSource<Feature<Polygon>>();
      const layer = new VectorLayer({
        source,
        style: new Style({
          fill: new Fill({ color: "rgba(34, 120, 34, 0.12)" }),
          stroke: new Stroke({ color: palette.forest[500], width: 2 }),
        }),
        zIndex: 60,
      });
      layerRef.current = layer;
      map.addLayer(layer);
    } else {
      layerRef.current.getSource()?.clear();
    }

    // Dynamic style function while sketching
    const getDrawStyle = () => {
      const area = areaKm2Ref.current;
      const { strokeColor, fillColor } = getAreaColor(area);
      return [
        new Style({
          fill: new Fill({ color: fillColor }),
          stroke: new Stroke({
            color: strokeColor,
            width: 2,
            lineDash: [6, 4],
          }),
        }),
        new Style({
          image: new CircleStyle({
            radius: 5,
            fill: new Fill({ color: strokeColor }),
            stroke: new Stroke({ color: "#fff", width: 1.5 }),
          }),
        }),
      ];
    };

    const draw = new Draw({
      source: layerRef.current.getSource()!,
      type: "Polygon",
      style: getDrawStyle,
      finishCondition: () => {
        if (areaKm2Ref.current > MAX_STATS_AREA_KM2) {
          message.warning("Reduce the polygon area before closing");
          return false;
        }
        return true;
      },
    });

    // Live area calculation
    draw.on("drawstart", (event) => {
      const geometry = event.feature.getGeometry() as Polygon;
      setCanFinish(false);

      geometry.on("change", () => {
        const coords3857 = geometry.getCoordinates()[0];
        if (coords3857.length < 3) {
          resetDrawingState();
          return;
        }

        const coords4326 = coords3857.map((c) => toLonLat(c));
        try {
          const turfPoly = turf.polygon([coords4326]);
          const areaKm2 = turf.area(turfPoly) / 1_000_000;
          areaKm2Ref.current = areaKm2;
          setCanFinish(coords3857.length >= 4 && areaKm2 <= MAX_STATS_AREA_KM2);

          const lastCoord =
            coords3857[coords3857.length - 2] ??
            coords3857[coords3857.length - 1];
          updateOverlay(areaKm2, lastCoord);

          // Update the finished-polygon layer style in sync
          if (layerRef.current) {
            const { strokeColor, fillColor } = getAreaColor(areaKm2);
            layerRef.current.setStyle(
              new Style({
                fill: new Fill({ color: fillColor }),
                stroke: new Stroke({ color: strokeColor, width: 2 }),
              }),
            );
          }
        } catch {
          // Not a valid polygon yet
          setCanFinish(false);
        }
      });
    });

    draw.on("drawend", (event) => {
      const geometry = event.feature.getGeometry() as Polygon;
      const coords3857 = geometry.getCoordinates()[0];
      const coords4326 = coords3857.map((c) => toLonLat(c));
      const turfPolygon = turf.polygon([coords4326]);
      const areaKm2 = turf.area(turfPolygon) / 1_000_000;

      if (areaKm2 < 0.0001) {
        message.error("Polygon is too small. Please draw a larger area.");
        layerRef.current?.getSource()?.clear();
      } else {
        const geoJsonPolygon: GeoJSON.Polygon = {
          type: "Polygon",
          coordinates: [coords4326],
        };
        setModalOpen(true);
        stats.fetchStats(geoJsonPolygon);
      }

      resetDrawingState();
      const drawToRemove = drawRef.current;
      removeDrawInteraction(drawToRemove, true);
    });

    map.addInteraction(draw);
    drawRef.current = draw;
    setIsDrawing(true);
    message.info(
      "Tap or click on the map to draw a polygon. Double-click or use Done to finish.",
    );
  }, [
    mapRef,
    isDrawing,
    ensureOverlay,
    updateOverlay,
    stats,
    resetDrawingState,
    removeDrawInteraction,
  ]);

  const cancelDrawing = useCallback(() => {
    const draw = drawRef.current;
    if (draw) {
      draw.abortDrawing();
    }
    layerRef.current?.getSource()?.clear();
    resetDrawingState();
    removeDrawInteraction(draw);
  }, [resetDrawingState, removeDrawInteraction]);

  const undoLastPoint = useCallback(() => {
    drawRef.current?.removeLastPoint();
  }, []);

  const finishDrawing = useCallback(() => {
    if (!drawRef.current) return;
    if (areaKm2Ref.current > MAX_STATS_AREA_KM2) {
      message.warning("Reduce the polygon area before closing");
      return;
    }
    drawRef.current.finishDrawing();
  }, []);

  /** Toggle drawing on/off – wire this to the "Analyse Area" button. */
  const toggle = useCallback(() => {
    if (isDrawing) {
      cancelDrawing();
    } else {
      startDrawing();
    }
  }, [isDrawing, cancelDrawing, startDrawing]);

  /** Close the results modal and clear the drawn polygon. */
  const closeModal = useCallback(() => {
    setModalOpen(false);
    stats.reset();
    layerRef.current?.getSource()?.clear();
  }, [stats]);

  // ---- public API ----
  return {
    isDrawing,
    start: startDrawing,
    cancel: cancelDrawing,
    undoLastPoint,
    finish: finishDrawing,
    canFinish,
    toggle,
    modalOpen,
    closeModal,
    stats,
  };
}
