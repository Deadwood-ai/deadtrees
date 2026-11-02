import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Map from "ol/Map.js";
import type MapBrowserEvent from "ol/MapBrowserEvent.js";
import Draw, { createBox } from "ol/interaction/Draw.js";
import VectorSource from "ol/source/Vector.js";
import VectorLayer from "ol/layer/Vector.js";
import { Style, Fill, Stroke } from "ol/style";
import Feature from "ol/Feature.js";
import Polygon from "ol/geom/Polygon.js";
import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { message } from "antd";
import { requestConcepts, requestSegmentation, warmUpSegmentation, type SamPrompt } from "../utils/samRequest";
import { keepLargestPolygon, pixelPolygonsToFeatures, toPixelFeatureCollection } from "../utils/samGeometry";
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
  /** Adds an outline for every instance of `text` (for example "tree") in the current view. */
  findConcept: (text: string) => Promise<void>;
  canUse: boolean;
}

/** One AI outline being shaped: the frozen view image, its box and the refinement clicks so far. */
interface Session extends Required<SamPrompt> {
  features: Feature[];
  boxFeature: Feature;
}

const REFINE_HINT = "Click to add to the outline, Alt-click to remove. Press S when it fits.";

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

  const setNavigationLocked = useCallback((map: Map, locked: boolean) => {
    map.getInteractions().forEach((i) => i.setActive(!locked));
  }, []);

  const endSession = useCallback(() => {
    const map = mapRef.current;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (map && clickKeyRef.current) {
      map.un("click", clickKeyRef.current);
      clickKeyRef.current = null;
    }
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
      const outline = fc ? pixelPolygonsToFeatures(keepLargestPolygon(fc), (p) => map.getCoordinateFromPixel(p)) : [];
      if (sessionRef.current !== session) return; // ended while waiting
      const source = resultSource(map);
      if (session.features.length === 0 && outline.length) onBeforeAddFeatures?.();
      session.features.forEach((f) => source.removeFeature(f));
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
    session.points.push([Math.round(e.pixel[0]), Math.round(e.pixel[1])]);
    session.labels.push((e.originalEvent as MouseEvent).altKey ? 0 : 1);
    void runSession(map, session);
  }, [mapRef, runSession]);

  const startSession = useCallback(async (map: Map, boxGeometry: Polygon) => {
    setNavigationLocked(map, true);
    const image = await captureOrthoView(map, getOrthoLayer());
    if (!image) {
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
      image,
      box: [x1, y1, x2, y2].map(Math.round),
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
    clickKeyRef.current = refine;
    map.on("click", refine);
    message.info(REFINE_HINT);
  }, [disable, getOrthoLayer, refine, runSession, setNavigationLocked]);

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

  const findConcept = useCallback(async (text: string) => {
    const map = mapRef.current;
    if (!map || !canUse || isActive) return;
    setIsProcessing(true);
    setNavigationLocked(map, true);
    try {
      const image = await captureOrthoView(map, getOrthoLayer());
      if (!image) throw new Error("The map view could not be captured for AI search.");
      const fc = toPixelFeatureCollection(await requestConcepts(image, text));
      const found = fc ? pixelPolygonsToFeatures(fc, (p) => map.getCoordinateFromPixel(p)) : [];
      if (found.length === 0) {
        message.info(`No ${text} found in this view.`);
        return;
      }
      onBeforeAddFeatures?.();
      found.forEach((f) => f.set("is_new", true));
      resultSource(map).addFeatures(found);
      message.success(`Added ${found.length} outlines. Check them before saving.`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "AI search failed.");
    } finally {
      setNavigationLocked(map, false);
      setIsProcessing(false);
    }
  }, [canUse, getOrthoLayer, isActive, mapRef, onBeforeAddFeatures, resultSource, setNavigationLocked]);

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

  return { isActive, isProcessing, enable, disable, findConcept, canUse };
};

/**
 * Captures what the map shows of the orthophoto as a JPEG, in the same pixel space as
 * map.getPixelFromCoordinate. Other layers are hidden for the capture only, so they neither
 * leak into the model input nor taint the canvas.
 */
async function captureOrthoView(map: Map, ortho: TileLayerWebGL | undefined): Promise<Blob | null> {
  if (!ortho) return null;
  const hidden = map
    .getLayers()
    .getArray()
    .filter((layer) => layer !== ortho && layer.getVisible());
  hidden.forEach((layer) => layer.setVisible(false));
  map.renderSync();
  const canvas = composeMapCanvas(map);
  hidden.forEach((layer) => layer.setVisible(true));
  map.renderSync();
  if (!canvas) return null;
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92));
}

function composeMapCanvas(map: Map): HTMLCanvasElement | null {
  const target = map.getTargetElement();
  // The bottom-most canvas holds the orthophoto.
  const source = target?.querySelector("canvas");
  if (!target || !source || source.width === 0 || source.height === 0) return null;
  const rect = target.getBoundingClientRect();
  const composite = document.createElement("canvas");
  composite.width = Math.max(1, Math.round(rect.width));
  composite.height = Math.max(1, Math.round(rect.height));
  const ctx = composite.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, composite.width, composite.height);
  return composite;
}

export default useAISegmentation;
