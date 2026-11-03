import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Map from "ol/Map.js";
import DragBox from "ol/interaction/DragBox.js";
import DragZoom from "ol/interaction/DragZoom.js";
import Draw from "ol/interaction/Draw.js";
import Modify from "ol/interaction/Modify.js";
import Select from "ol/interaction/Select.js";
import Translate from "ol/interaction/Translate.js";
import { shiftKeyOnly } from "ol/events/condition.js";
import type MapBrowserEvent from "ol/MapBrowserEvent.js";
import VectorSource from "ol/source/Vector.js";
import VectorLayer from "ol/layer/Vector.js";
import { Style, Fill, Stroke } from "ol/style";
import Feature from "ol/Feature.js";
import type Geometry from "ol/geom/Geometry.js";
import Polygon from "ol/geom/Polygon.js";
import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { message } from "antd";
import {
  requestConcepts,
  requestSegmentation,
  warmUpSegmentation,
} from "../utils/samRequest";
import {
  captureScale,
  keepLargestPolygon,
  pixelPolygonsToFeatures,
  toPixelFeatureCollection,
} from "../utils/samGeometry";
import { clipToArea, removeArea } from "../utils/areaEdits";
import { lockMapInteractions } from "../utils/mapInteractionLock";
import { palette } from "../theme/palette";

type GetOrthoLayerFn = () => TileLayerWebGL | undefined;

interface UseAISegmentationParams {
  mapRef: React.MutableRefObject<Map | null>;
  getOrthoLayer: GetOrthoLayerFn;
  getTargetVectorSource?: () => VectorSource | null | undefined;
  onBeforeAddFeatures?: () => void; // Called before adding AI-generated features (for undo history)
}

/** What a plain click does while AI is on: outline what is clicked, or cut it out of the layer. */
export type AIMode = "outline" | "cut";

interface UseAISegmentationReturn {
  isActive: boolean;
  mode: AIMode;
  setMode: (mode: AIMode) => void;
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

function toMapCoordinate(
  frame: CaptureFrame,
  pixel: [number, number],
): number[] {
  return [
    frame.origin[0] + (pixel[0] / frame.scale) * frame.resolution,
    frame.origin[1] - (pixel[1] / frame.scale) * frame.resolution,
  ];
}

/** The last AI outline: what the model saw and was asked, so Shift/Alt-clicks can refine it. */
interface Outline {
  image: Blob;
  frame: CaptureFrame;
  box: number[] | null;
  points: number[][];
  labels: number[];
  features: Feature[];
}

const AI_HINT =
  "AI is on: click a tree to outline it. The panel under the AI button lists the other actions.";

/**
 * AI segmentation for the polygon editors.
 *
 * While AI is on, a click outlines the tree under it and Shift-drag outlines what is inside a box.
 * Shift-click adds to the last outline; Alt-click cuts what is under it out of the layer (a gap
 * in tree cover, a live branch in deadwood). The map is locked only while the view is
 * captured; outlines are placed through the capture's frame, so panning and zooming keep working.
 */
export const useAISegmentation = ({
  mapRef,
  getOrthoLayer,
  getTargetVectorSource,
  onBeforeAddFeatures,
}: UseAISegmentationParams): UseAISegmentationReturn => {
  const [isActive, setIsActive] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [mode, setModeState] = useState<AIMode>("outline");
  // Read by the map click listener, which is attached once per AI session.
  const modeRef = useRef<AIMode>("outline");
  const setMode = useCallback((next: AIMode) => {
    modeRef.current = next;
    setModeState(next);
  }, []);

  const ownLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  // The dashed box lives on its own layer so an editor save never picks it up.
  const boxLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const lastRef = useRef<Outline | null>(null);
  // Bumped when AI is turned off, so a request still running cannot add its outline afterwards.
  const runRef = useRef(0);
  const busyRef = useRef(false);
  // Undoes what enable() attached: the click listener, the box interaction, Shift-drag zoom.
  const detachRef = useRef<(() => void) | null>(null);

  const canUse = useMemo(() => !!getOrthoLayer(), [getOrthoLayer]);

  // AI outlines go to the editor's layer when there is one, otherwise to a layer owned here.
  const resultSource = useCallback(
    (map: Map): VectorSource => {
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
    },
    [getTargetVectorSource],
  );

  const boxSource = useCallback((map: Map): VectorSource => {
    if (!boxLayerRef.current) {
      boxLayerRef.current = new VectorLayer<VectorSource>({
        source: new VectorSource(),
        style: new Style({
          stroke: new Stroke({
            color: palette.state.hover,
            width: 2,
            lineDash: [6, 4],
          }),
        }),
        className: "ai-segmentation-box",
      });
      map.addLayer(boxLayerRef.current);
    }
    return boxLayerRef.current.getSource()!;
  }, []);

  const disable = useCallback(() => {
    runRef.current += 1;
    detachRef.current?.();
    detachRef.current = null;
    lastRef.current = null;
    boxLayerRef.current?.getSource()?.clear();
    modeRef.current = "outline";
    setModeState("outline");
    setIsActive(false);
  }, []);

  /**
   * Asks the model for one outline. It replaces `replace` (a refined outline), or with `cut` it
   * is cut out of every polygon of the layer it overlaps.
   */
  const runPrompt = useCallback(
    async (
      map: Map,
      prompt: Omit<Outline, "features">,
      replace: Feature[],
      cut = false,
    ) => {
      const run = runRef.current;
      busyRef.current = true;
      setIsProcessing(true);
      try {
        const fc = toPixelFeatureCollection(await requestSegmentation(prompt));
        if (run !== runRef.current) return; // AI was turned off while waiting
        const outline = fc
          ? pixelPolygonsToFeatures(keepLargestPolygon(fc), (p) =>
              toMapCoordinate(prompt.frame, p),
            )
          : [];
        if (outline.length === 0) {
          message.info("The AI found no outline there. Try a box around it.");
          return;
        }
        const source = resultSource(map);
        if (cut) {
          const edit = removeArea(
            source.getFeatures() as Feature<Geometry>[],
            outline[0].getGeometry()!,
          );
          if (edit.removed.length === 0) {
            message.info(
              "Nothing to cut there: no polygon of this layer covers that spot.",
            );
            return;
          }
          onBeforeAddFeatures?.();
          edit.removed.forEach((f) => source.removeFeature(f));
          source.addFeatures(edit.added);
          return;
        }
        onBeforeAddFeatures?.();
        replace
          .filter((f) => source.hasFeature(f))
          .forEach((f) => source.removeFeature(f));
        outline.forEach((f) => f.set("is_new", true));
        source.addFeatures(outline);
        lastRef.current = { ...prompt, features: outline };
      } catch (e) {
        if (run === runRef.current)
          message.error(
            e instanceof Error ? e.message : "AI segmentation failed.",
          );
      } finally {
        busyRef.current = false;
        setIsProcessing(false);
        boxLayerRef.current?.getSource()?.clear();
      }
    },
    [onBeforeAddFeatures, resultSource],
  );

  /**
   * Captures the view (the only moment the map is locked) and outlines a click or a box in it;
   * with `cut` the outline is cut out of the layer instead of added.
   */
  const outlineNew = useCallback(
    async (
      map: Map,
      target: { pixel: number[] } | { box: Polygon },
      cut = false,
    ) => {
      if (busyRef.current) return;
      busyRef.current = true;
      const unlock = lockMapInteractions(map);
      const origin = map.getCoordinateFromPixel([0, 0]) as [number, number];
      const resolution = map.getView().getResolution() ?? 1;
      let box: number[] | null = null;
      let points: number[][] = [];
      if ("box" in target) {
        const [minX, minY, maxX, maxY] = target.box.getExtent();
        box = [
          ...map.getPixelFromCoordinate([minX, maxY]),
          ...map.getPixelFromCoordinate([maxX, minY]),
        ];
        boxSource(map).addFeature(new Feature(target.box));
      } else {
        points = [target.pixel];
      }
      const capture = await captureOrthoView(map, getOrthoLayer());
      unlock();
      busyRef.current = false;
      if (!capture) {
        message.error(
          "The map view could not be captured for AI segmentation.",
        );
        boxLayerRef.current?.getSource()?.clear();
        return;
      }
      const toImage = (v: number) => Math.round(v * capture.scale);
      await runPrompt(
        map,
        {
          image: capture.image,
          frame: { origin, resolution, scale: capture.scale },
          box: box && box.map(toImage),
          points: points.map((p) => p.map(toImage)),
          labels: points.map(() => 1),
        },
        [],
        cut,
      );
    },
    [boxSource, getOrthoLayer, runPrompt],
  );

  /** Adds the clicked spot to the last outline (label 1); label 0 would remove it. */
  const refineLast = useCallback(
    async (map: Map, coordinate: number[], label: 0 | 1) => {
      const last = lastRef.current;
      const source = resultSource(map);
      if (!last || !last.features.some((f) => source.hasFeature(f))) {
        message.info(
          "Click a tree first; Shift-click then adds to that outline.",
        );
        return;
      }
      const { frame } = last;
      const x =
        ((coordinate[0] - frame.origin[0]) / frame.resolution) * frame.scale;
      const y =
        ((frame.origin[1] - coordinate[1]) / frame.resolution) * frame.scale;
      const [width, height] = await imageSize(last.image);
      if (x < 0 || y < 0 || x > width || y > height) {
        message.info(
          "That spot was off screen when the outline was made. Click the tree again instead.",
        );
        return;
      }
      await runPrompt(
        map,
        {
          ...last,
          points: [...last.points, [Math.round(x), Math.round(y)]],
          labels: [...last.labels, label],
        },
        last.features,
      );
    },
    [resultSource, runPrompt],
  );

  const enable = useCallback(() => {
    const map = mapRef.current;
    if (!map || !canUse || detachRef.current) return;
    setIsActive(true);
    warmUpSegmentation();
    message.info(AI_HINT);

    const onClick = (
      e: MapBrowserEvent<PointerEvent | KeyboardEvent | WheelEvent>,
    ) => {
      if (busyRef.current) return;
      const event = e.originalEvent as MouseEvent;
      // Alt (⌥) flips the mode for one click.
      const cut = (modeRef.current === "cut") !== event.altKey;
      // A plain Shift-click reaches the box interaction as a cancelled box (handled there).
      if (event.altKey || !event.shiftKey)
        void outlineNew(map, { pixel: e.pixel }, cut);
    };
    // While AI is on, clicks belong to it: editing interactions pause (panning and zooming stay),
    // and Shift-drag draws an AI box instead of zooming to it.
    const paused = map
      .getInteractions()
      .getArray()
      .filter(
        (i) =>
          i.getActive() &&
          (i instanceof DragZoom ||
            i instanceof Select ||
            i instanceof Modify ||
            i instanceof Draw ||
            i instanceof Translate),
      );
    paused.forEach((i) => i.setActive(false));
    const boxDraw = new DragBox({ condition: shiftKeyOnly });
    boxDraw.on(
      "boxend",
      () => void outlineNew(map, { box: boxDraw.getGeometry() }),
    );
    // A Shift-click is a box too small to count: it adds the spot to the last outline.
    boxDraw.on("boxcancel", (e) => {
      if (!busyRef.current) void refineLast(map, e.coordinate, 1);
    });
    map.addInteraction(boxDraw);
    map.on("click", onClick);
    detachRef.current = () => {
      map.un("click", onClick);
      map.removeInteraction(boxDraw);
      paused.forEach((i) => i.setActive(true));
    };
  }, [canUse, mapRef, outlineNew, refineLast]);

  const findInArea = useCallback(
    async (text: string, area: Polygon): Promise<AreaSearch | null> => {
      const map = mapRef.current;
      if (!map || !canUse || isActive) return null;
      setIsProcessing(true);
      const unlock = lockMapInteractions(map);
      try {
        const crop = areaPixelRect(map, area);
        if (!crop) throw new Error("Mark an area inside the map view.");
        const capture = await captureOrthoView(map, getOrthoLayer(), crop);
        if (!capture)
          throw new Error("The map view could not be captured for AI search.");
        const fc = toPixelFeatureCollection(
          await requestConcepts(capture.image, text),
        );
        const { scale, origin } = capture;
        const toCoordinate = (p: [number, number]) =>
          map.getCoordinateFromPixel([
            p[0] / scale + origin[0],
            p[1] / scale + origin[1],
          ]);
        const found = fc ? pixelPolygonsToFeatures(fc, toCoordinate) : [];
        const best = found
          .sort((a, b) => (b.get("score") ?? 0) - (a.get("score") ?? 0))
          .slice(0, MAX_AREA_RESULTS);
        return { features: clipToArea(best, area), total: found.length };
      } catch (e) {
        message.error(e instanceof Error ? e.message : "AI search failed.");
        return null;
      } finally {
        unlock();
        setIsProcessing(false);
      }
    },
    [canUse, getOrthoLayer, isActive, mapRef],
  );

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

  return {
    isActive,
    mode,
    setMode,
    isProcessing,
    enable,
    disable,
    findInArea,
    canUse,
  };
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
  return right - left > 4 && bottom - top > 4
    ? [left, top, right - left, bottom - top]
    : null;
}

/** A captured view: image pixel = (map pixel - origin) * scale. */
interface ViewCapture {
  image: Blob;
  scale: number;
  origin: [number, number];
}

/** Width and height of a captured image, read back from the image itself. */
async function imageSize(image: Blob): Promise<[number, number]> {
  const bitmap = await createImageBitmap(image);
  const size: [number, number] = [bitmap.width, bitmap.height];
  bitmap.close();
  return size;
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
  const image = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.92),
  );
  return image ? { image, scale, origin } : null;
}

function composeMapCanvas(map: Map, crop?: PixelRect) {
  const target = map.getTargetElement();
  // The bottom-most canvas holds the orthophoto.
  const source = target?.querySelector("canvas");
  if (!target || !source || source.width === 0 || source.height === 0)
    return null;
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
  ctx.drawImage(
    source,
    x * ratio,
    y * ratio,
    width * ratio,
    height * ratio,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return { canvas, scale, origin: [x, y] as [number, number] };
}

export default useAISegmentation;
