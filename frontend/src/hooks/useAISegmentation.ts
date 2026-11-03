import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Map from "ol/Map.js";
import Draw, { createBox } from "ol/interaction/Draw.js";
import VectorSource from "ol/source/Vector.js";
import VectorLayer from "ol/layer/Vector.js";
import { Style, Fill, Stroke } from "ol/style";
import Feature from "ol/Feature.js";
import type Geometry from "ol/geom/Geometry.js";
import Polygon from "ol/geom/Polygon.js";
import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { message } from "antd";
import { requestConcepts, requestSegmentation, warmUpSegmentation } from "../utils/samRequest";
import { captureScale, keepLargestPolygon, pixelPolygonsToFeatures, toPixelFeatureCollection } from "../utils/samGeometry";
import { clipToArea } from "../utils/areaEdits";
import { lockMapInteractions } from "../utils/mapInteractionLock";
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

/**
 * Where the captured image sits on the map: the coordinate of its top-left pixel and the map
 * units per map pixel at capture time. The outline is converted through it, so the map can move
 * while the model works.
 */
interface CaptureFrame {
  origin: [number, number];
  resolution: number;
  scale: number;
}

function toMapCoordinate(frame: CaptureFrame, pixel: [number, number]): number[] {
  return [
    frame.origin[0] + (pixel[0] / frame.scale) * frame.resolution,
    frame.origin[1] - (pixel[1] / frame.scale) * frame.resolution,
  ];
}

/**
 * AI segmentation for the polygon editors.
 *
 * Turning AI on lets the user draw one box. The view is captured with it (the map is locked only
 * for that moment), the model's outline is added to the editor, and AI turns off again. Undo
 * removes an outline that does not fit.
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
  const ownLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  // The dashed box lives on its own layer so an editor save never picks it up.
  const boxLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  // Bumped when AI is turned off, so a request still running cannot add its outline afterwards.
  const runRef = useRef(0);

  const canUse = useMemo(() => !!getOrthoLayer(), [getOrthoLayer]);

  // AI outlines go to the editor's layer when there is one, otherwise to a layer owned here.
  const resultSource = useCallback((map: Map): VectorSource => {
    const target = getTargetVectorSource?.();
    if (target) return target;
    if (!ownLayerRef.current) {
      ownLayerRef.current = new VectorLayer<VectorSource>({
        source: new VectorSource(),
        style: new Style({
          fill: new Fill({ color: "rgba(0, 200, 255, 0.25)" }),
          stroke: new Stroke({ color: palette.state.hover, width: 2 }),
        }),
        className: "ai-segmentation-layer",
      });
      map.addLayer(ownLayerRef.current);
    }
    return ownLayerRef.current.getSource()!;
  }, [getTargetVectorSource]);

  const boxSource = useCallback((map: Map): VectorSource => {
    if (!boxLayerRef.current) {
      boxLayerRef.current = new VectorLayer<VectorSource>({
        source: new VectorSource(),
        style: new Style({ stroke: new Stroke({ color: palette.state.hover, width: 2, lineDash: [6, 4] }) }),
        className: "ai-segmentation-box",
      });
      map.addLayer(boxLayerRef.current);
    }
    return boxLayerRef.current.getSource()!;
  }, []);

  const disable = useCallback(() => {
    runRef.current += 1;
    const map = mapRef.current;
    if (map && drawRef.current) map.removeInteraction(drawRef.current);
    drawRef.current = null;
    boxLayerRef.current?.getSource()?.clear();
    setIsActive(false);
  }, [mapRef]);

  /** Sends the box with the captured view and adds the returned outline; then AI is off. */
  const segmentBox = useCallback(async (map: Map, box: Polygon) => {
    const run = runRef.current;
    const unlock = lockMapInteractions(map);
    const frameBase = {
      origin: map.getCoordinateFromPixel([0, 0]) as [number, number],
      resolution: map.getView().getResolution() ?? 1,
    };
    const [minX, minY, maxX, maxY] = box.getExtent();
    const [x1, y1] = map.getPixelFromCoordinate([minX, maxY]);
    const [x2, y2] = map.getPixelFromCoordinate([maxX, minY]);
    const capture = await captureOrthoView(map, getOrthoLayer());
    // The frame fixes the conversion now, so the map may move while the model works.
    unlock();
    if (!capture) {
      message.error("The map view could not be captured for AI segmentation.");
      disable();
      return;
    }
    const boxFeature = new Feature(box);
    boxSource(map).addFeature(boxFeature);
    setIsProcessing(true);
    try {
      const fc = toPixelFeatureCollection(
        await requestSegmentation({
          image: capture.image,
          box: [x1, y1, x2, y2].map((v) => Math.round(v * capture.scale)),
          points: [],
          labels: [],
        }),
      );
      if (run !== runRef.current) return; // AI was turned off while waiting
      const frame: CaptureFrame = { ...frameBase, scale: capture.scale };
      const outline = fc ? pixelPolygonsToFeatures(keepLargestPolygon(fc), (p) => toMapCoordinate(frame, p)) : [];
      if (outline.length === 0) {
        message.info("The AI found no outline in this box. Try a tighter box.");
        return;
      }
      onBeforeAddFeatures?.();
      outline.forEach((f) => f.set("is_new", true));
      resultSource(map).addFeatures(outline);
    } catch (e) {
      if (run === runRef.current) message.error(e instanceof Error ? e.message : "AI segmentation failed.");
    } finally {
      setIsProcessing(false);
      if (run === runRef.current) disable();
    }
  }, [boxSource, disable, getOrthoLayer, onBeforeAddFeatures, resultSource]);

  const enable = useCallback(() => {
    const map = mapRef.current;
    if (!map || !canUse || isActive) return;
    setIsActive(true);
    warmUpSegmentation();
    const draw = new Draw({ source: new VectorSource(), type: "Circle", geometryFunction: createBox(), stopClick: true });
    draw.on("drawend", (evt) => {
      map.removeInteraction(draw);
      drawRef.current = null;
      const geometry = evt.feature.getGeometry();
      if (geometry instanceof Polygon) void segmentBox(map, geometry);
    });
    map.addInteraction(draw);
    drawRef.current = draw;
  }, [canUse, isActive, mapRef, segmentBox]);

  const findInArea = useCallback(async (text: string, area: Polygon): Promise<AreaSearch | null> => {
    const map = mapRef.current;
    if (!map || !canUse || isActive) return null;
    setIsProcessing(true);
    const unlock = lockMapInteractions(map);
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
      unlock();
      setIsProcessing(false);
    }
  }, [canUse, getOrthoLayer, isActive, mapRef]);

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
