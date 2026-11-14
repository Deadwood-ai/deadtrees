import { useCallback, useEffect, useRef, useState } from "react";
import type Map from "ol/Map.js";
import type Feature from "ol/Feature.js";
import type Geometry from "ol/geom/Geometry.js";
import Polygon from "ol/geom/Polygon.js";
import Draw from "ol/interaction/Draw.js";
import VectorLayer from "ol/layer/Vector.js";
import VectorSource from "ol/source/Vector.js";
import { Fill, Stroke, Style } from "ol/style.js";
import type MapBrowserEvent from "ol/MapBrowserEvent.js";
import { message } from "antd";
import { addArea, removeArea, type AreaEdit } from "../utils/areaEdits";
import type { AreaSearch } from "./useAISegmentation";
import { palette } from "../theme/palette";

export type AreaAction = "add" | "remove" | "find";

interface UseAreaToolsParams {
  mapRef: React.MutableRefObject<Map | null>;
  /** The editor layer the actions change. */
  getTargetSource: () => VectorSource | null | undefined;
  /** Called before a change so it is one undo step. */
  onBeforeChange: () => void;
  findInArea: (text: string, area: Polygon) => Promise<AreaSearch | null>;
}

export interface AreaToolsState {
  action: AreaAction | null;
  /** Candidates of a finished "find in area", waiting to be accepted or discarded. */
  preview: { count: number; total: number } | null;
  start: (action: AreaAction, prompt?: string) => void;
  cancel: () => void;
  acceptPreview: () => void;
  discardPreview: () => void;
}

const PREVIEW_STYLE = new Style({
  fill: new Fill({ color: "rgba(255, 200, 0, 0.12)" }),
  stroke: new Stroke({ color: palette.state.selected, width: 2, lineDash: [5, 4] }),
});

/**
 * Mark an area by dragging (freehand) and merge it into the editor layer, cut it out, or
 * search it with a text prompt. Search results stay a preview: click one to drop it, Enter to
 * add the rest, Esc to discard.
 */
export function useAreaTools({ mapRef, getTargetSource, onBeforeChange, findInArea }: UseAreaToolsParams): AreaToolsState {
  const [action, setAction] = useState<AreaAction | null>(null);
  const [preview, setPreview] = useState<{ count: number; total: number } | null>(null);
  const drawRef = useRef<Draw | null>(null);
  const previewLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const totalRef = useRef(0);
  // Bumped whenever the session moves on (cancel, new area, layer switch), so a search that
  // was still running cannot publish its results into the new session.
  const generationRef = useRef(0);

  const applyEdit = useCallback((edit: AreaEdit) => {
    const source = getTargetSource();
    if (!source || (edit.removed.length === 0 && edit.added.length === 0)) return;
    edit.removed.forEach((f) => source.removeFeature(f));
    source.addFeatures(edit.added);
  }, [getTargetSource]);

  const previewSource = useCallback((): VectorSource | null => {
    const map = mapRef.current;
    if (!map) return null;
    if (!previewLayerRef.current) {
      previewLayerRef.current = new VectorLayer({ source: new VectorSource(), style: PREVIEW_STYLE, zIndex: 1000 });
      map.addLayer(previewLayerRef.current);
    }
    return previewLayerRef.current.getSource();
  }, [mapRef]);

  const syncPreview = useCallback(() => {
    const count = previewLayerRef.current?.getSource()?.getFeatures().length ?? 0;
    setPreview(count > 0 ? { count, total: totalRef.current } : null);
  }, []);

  const discardPreview = useCallback(() => {
    previewLayerRef.current?.getSource()?.clear();
    syncPreview();
  }, [syncPreview]);

  const acceptPreview = useCallback(() => {
    const candidates = previewLayerRef.current?.getSource()?.getFeatures() ?? [];
    const target = getTargetSource();
    if (!target || candidates.length === 0) return;
    onBeforeChange();
    for (const candidate of candidates) {
      applyEdit(addArea(target.getFeatures() as Feature<Geometry>[], candidate.getGeometry()!));
    }
    message.success(`Added ${candidates.length} outlines.`);
    discardPreview();
  }, [applyEdit, discardPreview, getTargetSource, onBeforeChange]);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    const map = mapRef.current;
    if (map && drawRef.current) map.removeInteraction(drawRef.current);
    drawRef.current = null;
    setAction(null);
  }, [mapRef]);

  const finish = useCallback(async (kind: AreaAction, area: Polygon, prompt: string) => {
    const source = getTargetSource();
    if (!source) return;
    if (kind === "find") {
      const generation = generationRef.current;
      const result = await findInArea(prompt, area);
      if (!result || generation !== generationRef.current) return;
      if (result.features.length === 0) {
        message.info(`No "${prompt}" found in this area.`);
        return;
      }
      totalRef.current = result.total;
      const target = previewSource();
      target?.clear();
      target?.addFeatures(result.features);
      syncPreview();
      return;
    }
    onBeforeChange();
    const features = source.getFeatures() as Feature<Geometry>[];
    applyEdit(kind === "add" ? addArea(features, area) : removeArea(features, area));
  }, [applyEdit, findInArea, getTargetSource, onBeforeChange, previewSource, syncPreview]);

  const start = useCallback((kind: AreaAction, prompt = "") => {
    const map = mapRef.current;
    if (!map) return;
    cancel();
    discardPreview();
    const draw = new Draw({ source: new VectorSource(), type: "Polygon", freehand: true, stopClick: true });
    draw.on("drawend", (evt) => {
      const geometry = evt.feature.getGeometry();
      // Remove the interaction after OL has finished the drawend handling, without counting
      // as a cancel of the search that starts now.
      queueMicrotask(() => {
        map.removeInteraction(draw);
        if (drawRef.current === draw) drawRef.current = null;
        setAction(null);
      });
      if (geometry instanceof Polygon) void finish(kind, geometry, prompt.trim() || "tree");
    });
    map.addInteraction(draw);
    drawRef.current = draw;
    setAction(kind);
  }, [cancel, discardPreview, finish, mapRef]);

  // While candidates are shown: click drops one, Enter adds the rest, Esc discards them.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !preview) return;
    const onClick = (e: MapBrowserEvent<PointerEvent | KeyboardEvent | WheelEvent>) => {
      const layer = previewLayerRef.current;
      map.forEachFeatureAtPixel(e.pixel, (f) => {
        layer?.getSource()?.removeFeature(f as Feature<Geometry>);
        return true;
      }, { layerFilter: (l) => l === layer });
      syncPreview();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") acceptPreview();
      if (e.key === "Escape") discardPreview();
    };
    map.on("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      map.un("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [acceptPreview, discardPreview, mapRef, preview, syncPreview]);

  useEffect(() => {
    return () => {
      cancel();
      const layer = previewLayerRef.current;
      layer?.getMapInternal()?.removeLayer(layer);
      previewLayerRef.current = null;
    };
  }, [cancel]);

  return { action, preview, start, cancel, acceptPreview, discardPreview };
}
