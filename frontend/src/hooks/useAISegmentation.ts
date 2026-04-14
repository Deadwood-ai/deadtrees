import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Map from "ol/Map.js";
import Draw, { createBox } from "ol/interaction/Draw.js";
import VectorSource from "ol/source/Vector.js";
import VectorLayer from "ol/layer/Vector.js";
import { Style, Fill, Stroke } from "ol/style";
import Feature from "ol/Feature.js";
import Polygon from "ol/geom/Polygon.js";
import Geometry from "ol/geom/Geometry.js";
import TileLayerWebGL from "ol/layer/WebGLTile.js";
// import { GeoTIFF } from "ol/source";
// import View from "ol/View";
import { Settings } from "../config";
import Overlay from "ol/Overlay";
import { palette } from "../theme/palette";

type GetOrthoLayerFn = () => TileLayerWebGL | undefined;

interface UseAISegmentationParams {
  mapRef: React.MutableRefObject<Map | null>;
  getOrthoLayer: GetOrthoLayerFn;
  getTargetVectorSource?: () => VectorSource | null | undefined;
  onBeforeAddFeatures?: () => void; // Called before adding AI-generated features (for undo history)
}

interface UseAISegmentationReturn {
  isActive: boolean;
  isProcessing: boolean;
  error: string | null;
  features: Feature<Geometry>[];
  enable: () => void;
  disable: () => void;
  clear: () => void;
  canUse: boolean;
}

/**
 * AI Segmentation hook (MVP):
 * - Adds a draw-box interaction
 * - Captures ortho-only image from an offscreen OL map (~1200 max dim)
 * - Sends JPEG and bbox (pixels) to SAM endpoint
 * - Converts returned pixel polygons to map coordinates and adds a temp vector layer
 */
export const useAISegmentation = ({
  mapRef,
  getOrthoLayer,
  getTargetVectorSource,
  onBeforeAddFeatures,
}: UseAISegmentationParams): UseAISegmentationReturn => {
  const [isActive, setIsActive] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [features, setFeatures] = useState<Feature[]>([]);

  // Store draw interaction and result layer/source
  const drawInteractionRef = useRef<Draw | null>(null);
  const resultSourceRef = useRef<VectorSource | null>(null);
  const resultLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null); // no longer used for rendering
  const disabledInteractionsRef = useRef<boolean>(false);
  type HideableLayer = { setVisible: (v: boolean) => void; getVisible: () => boolean };
  const hiddenLayersRef = useRef<Array<{ layer: HideableLayer; prevVisible: boolean }>>([]);
  const tempBboxFeatureRef = useRef<Feature | null>(null);
  const spinnerRef = useRef<HTMLDivElement | null>(null);
  const spinnerOverlayRef = useRef<Overlay | null>(null);
  const removeTempUI = useCallback(() => {
    if (overlayCanvasRef.current) {
      const parent = overlayCanvasRef.current.parentElement;
      if (parent) parent.removeChild(overlayCanvasRef.current);
      overlayCanvasRef.current = null;
    }
    if (tempBboxFeatureRef.current && resultSourceRef.current) {
      resultSourceRef.current.removeFeature(tempBboxFeatureRef.current);
      tempBboxFeatureRef.current = null;
    }
    if (spinnerOverlayRef.current && mapRef.current) {
      try {
        mapRef.current.removeOverlay(spinnerOverlayRef.current);
      } catch (e) {
        // ignore overlay removal errors
      }
      spinnerOverlayRef.current = null;
    }
    if (spinnerRef.current && spinnerRef.current.parentElement) {
      spinnerRef.current.parentElement.removeChild(spinnerRef.current);
      spinnerRef.current = null;
    }
  }, [mapRef]);

  const canUse = useMemo(() => !!getOrthoLayer(), [getOrthoLayer]);

  // Ensure result layer exists on the main map
  const ensureResultLayer = useCallback(() => {
    const map = mapRef.current;
    if (!map) {
      console.debug("[AI Seg] ensureResultLayer: no map");
      return;
    }

    // If caller provides a target vector source (e.g., polygon editor overlay), always use it
    const targetSource = getTargetVectorSource?.();
    console.debug("[AI Seg] ensureResultLayer: targetSource =", !!targetSource);
    if (targetSource) {
      resultSourceRef.current = targetSource;
      resultLayerRef.current = null; // not owned here
      console.debug("[AI Seg] Using provided target source");
      return;
    }

    // Early return only if we already have our own layer (not using target source)
    if (resultLayerRef.current && resultSourceRef.current) {
      console.debug("[AI Seg] Already have result layer");
      return;
    }

    // Fallback: create a temporary result layer owned by this hook
    console.debug("[AI Seg] Creating fallback AI layer");
    const source = new VectorSource();
    const layer = new VectorLayer<VectorSource>({
      source,
      style: new Style({
        fill: new Fill({ color: "rgba(0, 200, 255, 0.25)" }),
        stroke: new Stroke({ color: palette.state.hover, width: 2 }),
      }),
      className: "ai-segmentation-layer",
    });
    map.addLayer(layer);
    resultSourceRef.current = source;
    resultLayerRef.current = layer;
  }, [getTargetVectorSource, mapRef]);

  const removeResultLayer = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    if (resultLayerRef.current) {
      map.removeLayer(resultLayerRef.current);
      // dispose and clear
      const src = resultLayerRef.current.getSource();
      if (src) {
        src.clear();
        const maybeDisposable = src as unknown as { dispose?: () => void };
        if (typeof maybeDisposable.dispose === "function") {
          maybeDisposable.dispose();
        }
      }
      const maybeLayerDisposable = resultLayerRef.current as unknown as { dispose?: () => void };
      if (typeof maybeLayerDisposable.dispose === "function") {
        maybeLayerDisposable.dispose();
      }
      resultLayerRef.current = null;
      resultSourceRef.current = null;
    }
  }, [mapRef]);

  const clear = useCallback(() => {
    setError(null);
    setFeatures([]);
    if (resultSourceRef.current) {
      resultSourceRef.current.clear();
    }
  }, []);

  const disable = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    setIsActive(false);
    if (drawInteractionRef.current) {
      map.removeInteraction(drawInteractionRef.current);
      drawInteractionRef.current = null;
    }
    // Re-enable interactions if we disabled them
    if (disabledInteractionsRef.current) {
      map.getInteractions().forEach((i) => i.setActive(true));
      disabledInteractionsRef.current = false;
    }
    // Restore hidden layers
    if (hiddenLayersRef.current.length > 0) {
      hiddenLayersRef.current.forEach(({ layer, prevVisible }) => {
        layer.setVisible(prevVisible);
      });
      hiddenLayersRef.current = [];
      map.renderSync();
    }
    removeTempUI();
  }, [mapRef, removeTempUI]);

  const enable = useCallback(() => {
    const map = mapRef.current;
    if (!map || !canUse) return;
    setError(null);
    setIsActive(true);
    ensureResultLayer();

    // Create an invisible target vector layer to host the draw interaction geometry (not added to map)
    const draw = new Draw({
      source: new VectorSource(),
      type: "Circle",
      geometryFunction: createBox(),
      stopClick: true,
    });

    draw.on("drawend", async (evt) => {
      try {
        setIsProcessing(true);
        setError(null);
        removeTempUI();
        // During processing: disable all map interactions
        map.getInteractions().forEach((i) => i.setActive(false));
        disabledInteractionsRef.current = true;

        // Hide all non-ortho layers to avoid CORS taint. Keep our result/overlay visible.
        const ortho = getOrthoLayer();
        hiddenLayersRef.current = [];
        const layers = map.getLayers().getArray();
        layers.forEach((layer: unknown) => {
          const l = layer as HideableLayer;
          // Keep the editor overlay visible when using provided target source
          let isTargetOverlay = false;
          try {
            if (resultSourceRef.current && layer instanceof VectorLayer) {
              const src = (layer as VectorLayer<VectorSource>).getSource?.();
              isTargetOverlay = src === resultSourceRef.current;
            }
          } catch (e) {
            // ignore comparison errors
          }

          const shouldHide = layer !== ortho && layer !== resultLayerRef.current && !isTargetOverlay;
          if (shouldHide && typeof l.setVisible === "function") {
            hiddenLayersRef.current.push({ layer: l, prevVisible: l.getVisible() });
            l.setVisible(false);
          }
        });
        map.renderSync();

        // Get extent in map coordinates from the drawn polygon
        const geometry = evt.feature.getGeometry();
        if (!(geometry instanceof Polygon)) {
          setIsProcessing(false);
          return;
        }
        const extent = geometry.getExtent();
        const [minX, minY, maxX, maxY] = extent;

        {
          // Compute bbox pixels in the CURRENT MAP pixel space (CSS pixels)
          const topLeft = map.getPixelFromCoordinate([minX, maxY]);
          const bottomRight = map.getPixelFromCoordinate([maxX, minY]);
          if (!topLeft || !bottomRight) {
            throw new Error("Failed to compute bbox pixels.");
          }
          const x1 = Math.round(topLeft[0]);
          const y1 = Math.round(topLeft[1]);
          const x2 = Math.round(bottomRight[0]);
          const y2 = Math.round(bottomRight[1]);

          // Compose visible map into a single canvas (ortho-only) and crop the bbox
          const composite = composeCurrentMapCanvas(map);
          if (!composite) {
            throw new Error("Failed to access map canvas for cropping.");
          }
          // Show temporary bbox and spinner (use OL overlay for pixel-perfect centering)
          const rectCoords = [
            [minX, minY],
            [maxX, minY],
            [maxX, maxY],
            [minX, maxY],
            [minX, minY],
          ];
          const rect = new Polygon([rectCoords]);
          const tempFeature = new Feature(rect);
          // Mark as temporary bbox to avoid hover styling overrides
          try {
            tempFeature.set("dt_role", "bbox");
          } catch (e) {
            // ignore tempFeature property set error
          }
          tempFeature.setStyle(
            new Style({
              stroke: new Stroke({ color: palette.state.hover, width: 2, lineDash: [6, 4] }),
              fill: new Fill({ color: "rgba(0,200,255,0.06)" }),
            }),
          );
          ensureResultLayer();
          resultSourceRef.current?.addFeature(tempFeature);
          tempBboxFeatureRef.current = tempFeature;

          ensureSpinnerKeyframes();
          const spinner = document.createElement("div");
          spinner.style.width = "16px";
          spinner.style.height = "16px";
          spinner.style.borderRadius = "50%";
          spinner.style.background = "rgba(0,200,255,0.7)";
          spinner.style.boxShadow = "0 0 8px rgba(0,200,255,0.8)";
          spinner.style.animation = "aiPulse 0.9s ease-in-out infinite";
          spinner.style.zIndex = "1000";
          spinnerRef.current = spinner;

          const overlay = new Overlay({ element: spinner, positioning: "center-center", stopEvent: false });
          overlay.setPosition([(minX + maxX) / 2, (minY + maxY) / 2]);
          map.addOverlay(overlay);
          spinnerOverlayRef.current = overlay;

          // No overlay image: we only use composite to build the API input
          await new Promise((r) => requestAnimationFrame(() => r(null)));

          // Now: send the SAME composite image and bbox to the API and render returned polygons
          const imageBlob: Blob = await canvasToBlob(composite, "image/jpeg", 0.92);
          const file = new File([imageBlob], "view.jpg", { type: "image/jpeg" });
          const form = new FormData();
          form.append("image", file);
          form.append("bboxes", JSON.stringify([x1, y1, x2, y2]));
          form.append("labels", JSON.stringify([1]));

          const response = await fetch(`${Settings.SAM_API_URL}/segment`, {
            method: "POST",
            mode: "cors",
            headers: { Accept: "application/json" },
            body: form,
          });
          if (!response.ok) {
            throw new Error(`Segmentation failed (${response.status})`);
          }
          const raw = await response.json();
          const fc = normalizeToFeatureCollection(raw);
          const filtered = fc ? keepLargestPolygon(fc) : null;
          const created = filtered ? convertPixelGeoJSONToMapFeatures(filtered, map) : [];
          console.debug("[AI Seg] Created features:", created.length);
          ensureResultLayer();
          console.debug("[AI Seg] resultSourceRef.current =", !!resultSourceRef.current);
          if (resultSourceRef.current && created.length) {
            // Save history before adding AI-generated features (for undo)
            if (onBeforeAddFeatures) {
              onBeforeAddFeatures();
            }
            // Mark all AI-generated features as new (for save detection)
            created.forEach((f) => f.set("is_new", true));
            console.debug("[AI Seg] Adding", created.length, "features to source");
            resultSourceRef.current.addFeatures(created);
            console.debug(
              "[AI Seg] Features added. Source now has",
              resultSourceRef.current.getFeatures().length,
              "features",
            );
          }
          if (created.length) setFeatures((prev) => [...prev, ...created]);

          // After rendering features, restore layers and interactions
          if (hiddenLayersRef.current.length > 0) {
            hiddenLayersRef.current.forEach(({ layer, prevVisible }) => {
              layer.setVisible(prevVisible);
            });
            hiddenLayersRef.current = [];
            map.renderSync();
          }
          removeTempUI();
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error";
        setError(message);
      } finally {
        const mapFinal = mapRef.current;
        if (mapFinal) {
          mapFinal.getInteractions().forEach((i) => i.setActive(true));
        }
        disabledInteractionsRef.current = false;
        removeTempUI();
        if (drawInteractionRef.current && mapFinal) {
          mapFinal.removeInteraction(drawInteractionRef.current);
          drawInteractionRef.current = null;
        }
        setIsActive(false);
        setIsProcessing(false);
      }
    });

    map.addInteraction(draw);
    drawInteractionRef.current = draw;
  }, [canUse, ensureResultLayer, getOrthoLayer, mapRef, removeTempUI, onBeforeAddFeatures]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      disable();
      removeResultLayer();
    };
  }, [disable, removeResultLayer]);

  return {
    isActive,
    isProcessing,
    error,
    features,
    enable,
    disable,
    clear,
    canUse,
  };
};

// Removed offscreen helpers (not used in MVP path)

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Failed to encode canvas"));
          } else {
            resolve(blob);
          }
        },
        type,
        quality,
      );
    } catch (e) {
      reject(e);
    }
  });
}

function composeCurrentMapCanvas(map: Map): HTMLCanvasElement | null {
  const target = map.getTargetElement();
  if (!target) return null;
  // Draw only the bottom-most map canvas (expected to be the ortho raster)
  const canvasesAll = Array.from(target.querySelectorAll("canvas"));
  const canvases = canvasesAll.length ? [canvasesAll[0]] : [];
  if (!canvases.length) return null;

  const rect = target.getBoundingClientRect();
  const composite = document.createElement("canvas");
  composite.width = Math.max(1, Math.round(rect.width));
  composite.height = Math.max(1, Math.round(rect.height));
  const ctx = composite.getContext("2d");
  if (!ctx) return null;

  canvases.forEach((canvas: HTMLCanvasElement) => {
    if (canvas.width > 0 && canvas.height > 0) {
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, composite.width, composite.height);
    }
  });

  return composite;
}

function ensureSpinnerKeyframes() {
  const id = "ai-pulse-keyframes";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `@keyframes aiPulse { 0% { transform: scale(0.9); opacity: 0.6; } 50% { transform: scale(1.08); opacity: 1; } 100% { transform: scale(0.9); opacity: 0.6; } }`;
  document.head.appendChild(style);
}

// (intentionally left out) previously attempted layer-specific canvas detection

type PixelPolygon = { type: "Polygon"; coordinates: number[][][] };
type PixelFeature = { type: "Feature"; geometry: PixelPolygon; properties?: Record<string, unknown> };
type PixelFeatureCollection = { type: "FeatureCollection"; features: PixelFeature[] };

function convertPixelGeoJSONToMapFeatures(geojson: unknown, map: Map): Feature[] {
  const created: Feature[] = [];
  const collection = normalizeToFeatureCollection(geojson);
  if (!collection) return created;
  const sign = getYSign(collection);
  for (const feature of collection.features) {
    const geometry = feature.geometry;
    if (!geometry || geometry.type !== "Polygon" || !Array.isArray(geometry.coordinates)) continue;
    const rings = geometry.coordinates;
    const transformedRings: number[][][] = [];
    for (const ring of rings) {
      const transformedRing: number[][] = [];
      for (const coord of ring) {
        const [x, y] = coord as [number, number];
        const tx = x;
        const ty = sign * y;
        const mapCoord = map.getCoordinateFromPixel([tx, ty]);
        if (mapCoord) transformedRing.push(mapCoord);
      }
      if (transformedRing.length > 2) transformedRings.push(transformedRing);
    }
    if (transformedRings.length > 0) {
      const poly = new Polygon(transformedRings);
      const f = new Feature(poly);
      created.push(f);
    }
  }
  return created;
}

export default useAISegmentation;

// Remove overlay renderer (kept here for reference, but commented out)
/*
function drawPixelGeoJSONOnCanvas(
  geojson: PixelFeatureCollection,
  canvas: HTMLCanvasElement,
  offsetX: number,
  offsetY: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const sign = getYSign(geojson);

  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = palette.state.hover;
  ctx.lineWidth = 2;
  ctx.fillStyle = "rgba(0,200,255,0.15)";

  for (const feature of geojson.features) {
    const geometry = feature.geometry;
    if (!geometry || geometry.type !== "Polygon" || !Array.isArray(geometry.coordinates)) continue;
    for (const ring of geometry.coordinates as number[][][]) {
      ctx.beginPath();
      let first = true;
      for (const coord of ring) {
        const [x, y] = coord as [number, number];
        const sx = x - offsetX;
        const sy = sign * y - offsetY;
        if (first) {
          ctx.moveTo(sx, sy);
          first = false;
        } else {
          ctx.lineTo(sx, sy);
        }
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}
*/

function getYSign(fc: PixelFeatureCollection): 1 | -1 {
  let neg = 0;
  let pos = 0;
  outer: for (const f of fc.features) {
    const g = f.geometry;
    if (!g || g.type !== "Polygon") continue;
    for (const ring of g.coordinates as number[][][]) {
      for (const c of ring) {
        const y = c[1] as number;
        if (y < 0) neg++;
        else if (y > 0) pos++;
        if (neg + pos > 200) break outer; // sample first ~200 points
      }
    }
  }
  return neg > pos ? -1 : 1;
}

function normalizeToFeatureCollection(raw: unknown): PixelFeatureCollection | null {
  // Some responses wrap the segmentation under a 'segmentation' key
  const maybe = raw as Record<string, unknown> | null | undefined;
  const direct = maybe as Partial<PixelFeatureCollection> | null | undefined;
  const nested = maybe && typeof maybe === "object" ? (maybe["segmentation"] as Partial<PixelFeatureCollection>) : null;
  const fc = direct && direct.type === "FeatureCollection" ? direct : nested;
  if (fc && fc.type === "FeatureCollection" && Array.isArray(fc.features)) return fc as PixelFeatureCollection;
  return null;
}

function keepLargestPolygon(fc: PixelFeatureCollection): PixelFeatureCollection | null {
  let best: PixelFeature | null = null;
  let bestArea = -1;
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g || g.type !== "Polygon" || !Array.isArray(g.coordinates) || g.coordinates.length === 0) continue;
    const ring = g.coordinates[0] as number[][];
    const area = Math.abs(shoelaceArea(ring));
    if (area > bestArea) {
      bestArea = area;
      best = f;
    }
  }
  if (!best) return null;
  return { type: "FeatureCollection", features: [best] } as PixelFeatureCollection;
}

function shoelaceArea(points: number[][]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i] as [number, number];
    const [x2, y2] = points[(i + 1) % points.length] as [number, number];
    sum += x1 * y2 - x2 * y1;
  }
  return 0.5 * sum;
}
