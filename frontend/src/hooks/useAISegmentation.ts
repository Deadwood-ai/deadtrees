import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Map from "ol/Map.js";
import type MapBrowserEvent from "ol/MapBrowserEvent.js";
import Draw, { createBox } from "ol/interaction/Draw.js";
import VectorSource from "ol/source/Vector.js";
import VectorLayer from "ol/layer/Vector.js";
import { Style, Fill, Stroke } from "ol/style";
import Feature from "ol/Feature.js";
import type Geometry from "ol/geom/Geometry.js";
import { unByKey } from "ol/Observable.js";
import Polygon from "ol/geom/Polygon.js";
import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { message } from "antd";
import { requestConcepts, requestSegmentation, warmUpSegmentation, type SamPrompt } from "../utils/samRequest";
import { captureScale, keepLargestPolygon, pixelPolygonsToFeatures, toPixelFeatureCollection } from "../utils/samGeometry";
import { clipToArea } from "../utils/areaEdits";
import { lockMapInteractions } from "../utils/mapInteractionLock";
import { palette } from "../theme/palette";

type GetOrthoLayerFn = () => TileLayerWebGL | undefined;
type MapClick = MapBrowserEvent<PointerEvent | KeyboardEvent | WheelEvent>;

interface UseAISegmentationParams {
  mapRef: React.MutableRefObject<Map | null>;
  getOrthoLayer: GetOrthoLayerFn;
  getTargetVectorSource?: () => VectorSource | null | undefined;
  onBeforeAddFeatures?: () => void; // Called before adding AI-generated features (for undo history)
}

interface UseAISegmentationReturn {
  isActive: boolean;
  isProcessing: boolean;
  enable: () => void;
  disable: () => void;
  /** Outlines every instance of `text` inside `area`, best first; nothing is added to the map. */
  findInArea: (text: string, area: Polygon) => Promise<AreaSearch | null>;
  canUse: boolean;
}

/** Candidates from a text search in an area, clipped to it; `total` counts them before the cap. */
export interface AreaSearch {
  features: Feature<Geometry>[];
  total: number;
}

export const MAX_AREA_RESULTS = 100;

/** One AI outline being shaped: the frozen view image, its box and the refinement clicks so far. */
interface Session extends Required<SamPrompt> {
  /** Image pixels per map pixel; below 1 when a large view was shrunk for the service. */
  scale: number;
  features: Feature[];
  boxFeature: Feature;
  /** Stops watching the editor layer for the outline being removed (Undo, Delete, Cancel). */
  unwatch?: () => void;
}

const REFINE_HINT = "Click to add to the outline, Alt-click to remove. Press S or Finish AI when it fits.";

/**
 * AI segmentation for the polygon editors.
 *
 * Turning AI on lets the user draw a box. The view is captured once and sent with the box; the
 * returned outline is added to the editor. Further clicks refine that outline until AI is turned
 * off again. Map navigation stays locked during a session, because the outline is returned in
 * the pixel space of the captured view.
 */
export const useAISegmentation = ({
  mapRef,
  getOrthoLayer,
  getTargetVectorSource,
  onBeforeAddFeatures,
}: UseAISegmentationParams): UseAISegmentationReturn => {
  const [isActive, setIsActive] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const drawRef = useRef<Draw | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const resultSourceRef = useRef<VectorSource | null>(null);
  const ownLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  // The dashed box lives on its own layer so an editor save never picks it up.
  const boxLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const clickKeyRef = useRef<((e: MapClick) => void) | null>(null);
  // A click while a refinement is running would race it; such clicks are ignored.
  const busyRef = useRef(false);
  // Set while the hook swaps its own outline, so that removal does not end the session.
  const replacingRef = useRef(false);

  const canUse = useMemo(() => !!getOrthoLayer(), [getOrthoLayer]);

  // AI outlines go to the editor's layer when there is one, otherwise to a layer owned here.
  const resultSource = useCallback((map: Map): VectorSource => {
    const target = getTargetVectorSource?.();
    if (target) return (resultSourceRef.current = target);
    if (!ownLayerRef.current) {
      const source = new VectorSource();
      ownLayerRef.current = new VectorLayer<VectorSource>({
        source,
        style: new Style({
          fill: new Fill({ color: "rgba(0, 200, 255, 0.25)" }),
          stroke: new Stroke({ color: palette.state.hover, width: 2 }),
        }),
        className: "ai-segmentation-layer",
      });
      map.addLayer(ownLayerRef.current);
    }
    return (resultSourceRef.current = ownLayerRef.current.getSource()!);
  }, [getTargetVectorSource]);

  // Undoes the current map lock; unlocking restores only what the lock switched off.
  const unlockRef = useRef<(() => void) | null>(null);
  const setNavigationLocked = useCallback((map: Map, locked: boolean) => {
    if (locked) {
      unlockRef.current ??= lockMapInteractions(map);
    } else {
      unlockRef.current?.();
      unlockRef.current = null;
    }
  }, []);

  const endSession = useCallback(() => {
    const map = mapRef.current;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (map && clickKeyRef.current) {
      map.un("click", clickKeyRef.current);
      clickKeyRef.current = null;
    }
    session?.unwatch?.();
    if (session) boxLayerRef.current?.getSource()?.removeFeature(session.boxFeature);
    if (map) setNavigationLocked(map, false);
  }, [mapRef, setNavigationLocked]);

  const disable = useCallback(() => {
    const map = mapRef.current;
    if (map && drawRef.current) map.removeInteraction(drawRef.current);
    drawRef.current = null;
    endSession();
    setIsActive(false);
  }, [endSession, mapRef]);

  /** Runs the session's prompt and replaces its previous outline with the new one. */
  const runSession = useCallback(async (map: Map, session: Session) => {
    busyRef.current = true;
    setIsProcessing(true);
    try {
      const fc = toPixelFeatureCollection(await requestSegmentation(session));
      const toCoordinate = (p: [number, number]) => map.getCoordinateFromPixel([p[0] / session.scale, p[1] / session.scale]);
      const outline = fc ? pixelPolygonsToFeatures(keepLargestPolygon(fc), toCoordinate) : [];
      if (sessionRef.current !== session) return; // ended while waiting
      const source = resultSource(map);
      if (session.features.length === 0 && outline.length) onBeforeAddFeatures?.();
      replacingRef.current = true;
      session.features.forEach((f) => source.removeFeature(f));
      replacingRef.current = false;
      outline.forEach((f) => f.set("is_new", true));
      source.addFeatures(outline);
      session.features = outline;
    } catch (e) {
      message.error(e instanceof Error ? e.message : "AI segmentation failed.");
    } finally {
      busyRef.current = false;
      setIsProcessing(false);
    }
  }, [onBeforeAddFeatures, resultSource]);

  const refine = useCallback((e: MapClick) => {
    const map = mapRef.current;
    const session = sessionRef.current;
    if (!map || !session || busyRef.current) return;
    session.points.push([Math.round(e.pixel[0] * session.scale), Math.round(e.pixel[1] * session.scale)]);
    session.labels.push((e.originalEvent as MouseEvent).altKey ? 0 : 1);
    void runSession(map, session);
  }, [mapRef, runSession]);

  const startSession = useCallback(async (map: Map, boxGeometry: Polygon) => {
    setNavigationLocked(map, true);
    const capture = await captureOrthoView(map, getOrthoLayer());
    if (!capture) {
      message.error("The map view could not be captured for AI segmentation.");
      setNavigationLocked(map, false);
      return;
    }
    const [minX, minY, maxX, maxY] = boxGeometry.getExtent();
    const [x1, y1] = map.getPixelFromCoordinate([minX, maxY]);
    const [x2, y2] = map.getPixelFromCoordinate([maxX, minY]);
    const boxFeature = new Feature(boxGeometry);
    if (!boxLayerRef.current) {
      boxLayerRef.current = new VectorLayer<VectorSource>({
        source: new VectorSource(),
        style: new Style({ stroke: new Stroke({ color: palette.state.hover, width: 2, lineDash: [6, 4] }) }),
        className: "ai-segmentation-box",
      });
      map.addLayer(boxLayerRef.current);
    }
    boxLayerRef.current.getSource()!.addFeature(boxFeature);

    const session: Session = {
      image: capture.image,
      scale: capture.scale,
      box: [x1, y1, x2, y2].map((v) => Math.round(v * capture.scale)),
      points: [],
      labels: [],
      features: [],
      boxFeature,
    };
    sessionRef.current = session;
    await runSession(map, session);
    if (sessionRef.current !== session) return;
    if (session.features.length === 0) {
      // Nothing to refine: the request failed or found nothing. Unlock the map.
      disable();
      return;
    }
    // Undo, Delete or Cancel removing the outline ends the session and unlocks the map.
    const source = resultSource(map);
    const onRemoved = (e: { feature?: Feature }) => {
      if (!replacingRef.current && (!e.feature || session.features.includes(e.feature))) disable();
    };
    const removeKey = source.on("removefeature", onRemoved);
    const clearKey = source.on("clear", onRemoved);
    session.unwatch = () => unByKey([removeKey, clearKey]);
    clickKeyRef.current = refine;
    map.on("click", refine);
    message.info(REFINE_HINT);
  }, [disable, getOrthoLayer, refine, resultSource, runSession, setNavigationLocked]);

  const enable = useCallback(() => {
    const map = mapRef.current;
    if (!map || !canUse || drawRef.current) return;
    setIsActive(true);
    warmUpSegmentation();
    const draw = new Draw({ source: new VectorSource(), type: "Circle", geometryFunction: createBox(), stopClick: true });
    draw.on("drawend", (evt) => {
      map.removeInteraction(draw);
      drawRef.current = null;
      const geometry = evt.feature.getGeometry();
      if (geometry instanceof Polygon) void startSession(map, geometry);
    });
    map.addInteraction(draw);
    drawRef.current = draw;
  }, [canUse, mapRef, startSession]);

  const findInArea = useCallback(async (text: string, area: Polygon): Promise<AreaSearch | null> => {
    const map = mapRef.current;
    if (!map || !canUse || isActive) return null;
    setIsProcessing(true);
    setNavigationLocked(map, true);
    try {
      const crop = areaPixelRect(map, area);
      if (!crop) throw new Error("Mark an area inside the map view.");
      const capture = await captureOrthoView(map, getOrthoLayer(), crop);
      if (!capture) throw new Error("The map view could not be captured for AI search.");
      const fc = toPixelFeatureCollection(await requestConcepts(capture.image, text));
      const { scale, origin } = capture;
      const toCoordinate = (p: [number, number]) =>
        map.getCoordinateFromPixel([p[0] / scale + origin[0], p[1] / scale + origin[1]]);
      const found = fc ? pixelPolygonsToFeatures(fc, toCoordinate) : [];
      const best = found.sort((a, b) => (b.get("score") ?? 0) - (a.get("score") ?? 0)).slice(0, MAX_AREA_RESULTS);
      return { features: clipToArea(best, area), total: found.length };
    } catch (e) {
      message.error(e instanceof Error ? e.message : "AI search failed.");
      return null;
    } finally {
      setNavigationLocked(map, false);
      setIsProcessing(false);
    }
  }, [canUse, getOrthoLayer, isActive, mapRef, setNavigationLocked]);

  useEffect(() => {
    return () => {
      disable();
      for (const ref of [ownLayerRef, boxLayerRef]) {
        const layer = ref.current;
        layer?.getMapInternal()?.removeLayer(layer);
        ref.current = null;
      }
    };
  }, [disable]);

  return { isActive, isProcessing, enable, disable, findInArea, canUse };
};

/** The area's bounding box in map pixels, clamped to the view; null when it is off screen. */
function areaPixelRect(map: Map, area: Polygon): PixelRect | null {
  const [minX, minY, maxX, maxY] = area.getExtent();
  const [x1, y1] = map.getPixelFromCoordinate([minX, maxY]);
  const [x2, y2] = map.getPixelFromCoordinate([maxX, minY]);
  const [width, height] = map.getSize() ?? [0, 0];
  const left = Math.max(0, Math.floor(x1));
  const top = Math.max(0, Math.floor(y1));
  const right = Math.min(width, Math.ceil(x2));
  const bottom = Math.min(height, Math.ceil(y2));
  return right - left > 4 && bottom - top > 4 ? [left, top, right - left, bottom - top] : null;
}

/** A captured view: image pixel = (map pixel - origin) * scale. */
interface ViewCapture {
  image: Blob;
  scale: number;
  origin: [number, number];
}

/** Map pixel rectangle to capture instead of the whole view: [x, y, width, height]. */
type PixelRect = [number, number, number, number];

/**
 * Captures what the map shows of the orthophoto (or a rectangle of it) as a JPEG, scaled to the
 * service's size limit. Other layers are hidden for the capture only, so they neither leak into
 * the model input nor taint the canvas.
 */
async function captureOrthoView(
  map: Map,
  ortho: TileLayerWebGL | undefined,
  crop?: PixelRect,
): Promise<ViewCapture | null> {
  if (!ortho) return null;
  const hidden = map
    .getLayers()
    .getArray()
    .filter((layer) => layer !== ortho && layer.getVisible());
  hidden.forEach((layer) => layer.setVisible(false));
  map.renderSync();
  const composed = composeMapCanvas(map, crop);
  hidden.forEach((layer) => layer.setVisible(true));
  map.renderSync();
  if (!composed) return null;
  const { canvas, scale, origin } = composed;
  const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  return image ? { image, scale, origin } : null;
}

function composeMapCanvas(map: Map, crop?: PixelRect) {
  const target = map.getTargetElement();
  // The bottom-most canvas holds the orthophoto.
  const source = target?.querySelector("canvas");
  if (!target || !source || source.width === 0 || source.height === 0) return null;
  const view = target.getBoundingClientRect();
  const [x, y, width, height] = crop ?? [0, 0, view.width, view.height];
  // A small area may be enlarged (up to 2x) so the model sees more detail; a whole view never is.
  const scale = captureScale(width, height, crop ? 2 : 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const ratio = source.width / view.width; // device pixels per map pixel
  ctx.drawImage(source, x * ratio, y * ratio, width * ratio, height * ratio, 0, 0, canvas.width, canvas.height);
  return { canvas, scale, origin: [x, y] as [number, number] };
}

export default useAISegmentation;
