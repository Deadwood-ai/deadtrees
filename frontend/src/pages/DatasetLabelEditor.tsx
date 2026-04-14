import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button, Space, message, Radio } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import Map from "ol/Map";
import { defaults as defaultInteractions } from "ol/interaction/defaults";
import View from "ol/View";
import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { GeoTIFF } from "ol/source";
import { Settings } from "../config";
import { useDatasets } from "../hooks/useDatasets";
import { useDatasetLabelTypes } from "../hooks/useDatasetLabelTypes";
import usePolygonEditor from "../hooks/usePolygonEditor";
import useAISegmentation from "../hooks/useAISegmentation";
import VectorTileLayer from "ol/layer/VectorTile";
import Feature from "ol/Feature";
import Geometry from "ol/geom/Geometry";
import {
  createDeadwoodVectorLayer,
  createForestCoverVectorLayer,
} from "../components/DatasetDetailsMap/createVectorLayer";
import { Style, Stroke, Fill } from "ol/style";
import type { StyleFunction as OLStyleFunction } from "ol/style/Style";
import type { IDataset } from "../types/dataset";
import type MapBrowserEvent from "ol/MapBrowserEvent";
import { createOpenFreeMapLibertyLayerGroup } from "../utils/basemaps";
import { palette } from "../theme/palette";

type StyleFn = (f: Feature<Geometry>) => Style | null | undefined;

// deprecated: label ids are fetched via useDatasetLabelTypes
// type DatasetWithLabelIds = { deadwood_label_id?: number | null; forest_cover_label_id?: number | null };

export default function DatasetLabelEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: datasets } = useDatasets();

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const editor = usePolygonEditor({ mapRef });
  const ai = useAISegmentation({
    mapRef,
    getOrthoLayer: () => {
      if (!mapRef.current) return undefined;
      const layers = mapRef.current.getLayers().getArray();
      for (const l of layers) {
        if (l instanceof TileLayerWebGL) return l as TileLayerWebGL;
      }
      return undefined;
    },
    getTargetVectorSource: () => editor.getOverlayLayer()?.getSource() || null,
  });

  const [activeLayer, setActiveLayer] = useState<"deadwood" | "forest_cover">("deadwood");
  const serverLayerRef = useRef<VectorTileLayer | null>(null);
  const baseServerStyleRef = useRef<StyleFn | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string | number>>(new Set());
  const [hoveredServerId, setHoveredServerId] = useState<string | number | null>(null);
  const hiddenIdsRef = useRef<Set<string | number>>(new Set());
  const hoveredServerIdRef = useRef<string | number | null>(null);

  const dataset = useMemo(
    () => (datasets || []).find((d) => d.id.toString() === id) as IDataset | undefined,
    [datasets, id],
  );

  const labelTypes = useDatasetLabelTypes({ datasetId: dataset?.id, enabled: !!dataset?.id });

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current || !dataset) return;

    const basemapLayer = createOpenFreeMapLibertyLayerGroup();

    let orthoCogLayer: TileLayerWebGL | undefined;
    if (dataset?.cog_path) {
      orthoCogLayer = new TileLayerWebGL({
        source: new GeoTIFF({
          sources: [
            {
              url: Settings.COG_BASE_URL + dataset.cog_path,
              nodata: 0,
              bands: [1, 2, 3],
            },
          ],
          convertToRGB: true,
        }),
        maxZoom: 23,
        cacheSize: 4096,
        preload: 0,
      });
    }

    const view = new View({
      center: [0, 0],
      zoom: 2,
      maxZoom: 23,
      projection: "EPSG:3857",
    });

    const map = new Map({
      target: mapContainerRef.current,
      layers: orthoCogLayer ? [basemapLayer, orthoCogLayer] : [basemapLayer],
      view,
      controls: [],
      interactions: defaultInteractions({ doubleClickZoom: false }),
    });

    mapRef.current = map;

    if (orthoCogLayer) {
      const source = orthoCogLayer.getSource();
      source
        ?.getView()
        .then((viewOptions) => {
          if (viewOptions?.extent) {
            map.getView().fit(viewOptions.extent);
          }
        })
        .catch(() => {
          // ignore fit errors for MVP
        });
    }

    return () => {
      if (mapRef.current) {
        mapRef.current.setTarget(undefined);
        mapRef.current = null;
      }
      serverLayerRef.current = null;
      baseServerStyleRef.current = null;
    };
  }, [dataset]);

  // Swap prediction layer when activeLayer changes
  useEffect(() => {
    if (!mapRef.current || !dataset) return;
    const map = mapRef.current;

    // Remove existing server layer
    if (serverLayerRef.current) {
      map.removeLayer(serverLayerRef.current);
      serverLayerRef.current = null;
      baseServerStyleRef.current = null;
    }

    let newLayer: VectorTileLayer | undefined;
    const deadwoodId = labelTypes.deadwood.data?.id || null;
    const forestCoverId = labelTypes.forestCover.data?.id || null;
    if (activeLayer === "deadwood") {
      newLayer = createDeadwoodVectorLayer(deadwoodId || undefined);
    } else {
      newLayer = createForestCoverVectorLayer(forestCoverId || undefined);
    }

    if (newLayer) {
      map.addLayer(newLayer);
      try {
        newLayer.setZIndex(900);
      } catch (e) {
        // ignore
      }
      serverLayerRef.current = newLayer;
      const base = newLayer.getStyleFunction ? (newLayer.getStyleFunction() as unknown as StyleFn) : null;
      baseServerStyleRef.current = base;

      // Install stable style function that reads from refs
      const hoverStyle = new Style({
        fill: new Fill({ color: "rgba(234,179,8,0.15)" }),
        stroke: new Stroke({ color: palette.deadwood[500], width: 3, lineDash: [4, 2] }),
      });
      const styleFn: StyleFn = (feature) => {
        const idVal = feature.get("id");
        if (idVal !== undefined && hiddenIdsRef.current.has(idVal)) return null;
        if (hoveredServerIdRef.current !== null && idVal === hoveredServerIdRef.current) return hoverStyle;
        return baseServerStyleRef.current ? baseServerStyleRef.current(feature) : undefined;
      };
      newLayer.setStyle(styleFn as unknown as OLStyleFunction);
    } else {
      serverLayerRef.current = null;
      baseServerStyleRef.current = null;
    }
    // Reset masks and hover when swapping prediction layer to avoid stale ids
    setHiddenIds(new Set());
    setHoveredServerId(null);
  }, [activeLayer, dataset, labelTypes.deadwood.data?.id, labelTypes.forestCover.data?.id]);

  // Keep style function driven by refs fresh
  useEffect(() => {
    hiddenIdsRef.current = hiddenIds;
    serverLayerRef.current?.changed();
  }, [hiddenIds]);

  useEffect(() => {
    hoveredServerIdRef.current = hoveredServerId;
    serverLayerRef.current?.changed();
  }, [hoveredServerId]);

  // Copy-on-select: on single click on server layer, copy feature into overlay and hide it in server layer
  useEffect(() => {
    if (!mapRef.current || !serverLayerRef.current) return;
    const map = mapRef.current;

    const handleClick = (evt: MapBrowserEvent<UIEvent>) => {
      if (!editor.isEditing) return;
      let picked: Feature<Geometry> | null = null;
      map.forEachFeatureAtPixel(
        evt.pixel,
        (f, layer) => {
          if (layer === serverLayerRef.current && f instanceof Feature) {
            picked = f as Feature<Geometry>;
            return true;
          }
          return false;
        },
        { hitTolerance: 3 },
      );

      if (!picked) return;
      // Guard pick type at runtime to satisfy TS
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      if (!picked.get || typeof picked.get !== "function") return;
      const idVal = (picked as Feature<Geometry>).get("id");
      if (idVal === undefined) {
        message.warning("Feature has no id; cannot edit this feature.");
        return;
      }

      const geom = (picked as Feature<Geometry>).getGeometry();
      if (!geom) return;

      const clone = (picked as Feature<Geometry>).clone() as Feature<Geometry>;
      // Preserve original id so delete/clear can unhide
      try {
        clone.set("id", idVal);
      } catch (e) {
        // ignore
      }
      editor.getOverlayLayer()?.getSource()?.addFeature(clone);

      setHiddenIds((prev) => {
        const next = new Set(prev);
        next.add(idVal);
        return next;
      });
      setHoveredServerId(null);
      serverLayerRef.current?.changed();
    };

    map.on("click", handleClick);
    return () => {
      map.un("click", handleClick);
    };
  }, [editor, activeLayer, dataset, hiddenIds]);

  // Listen to overlay clears to unhide all server features that were masked
  // Note: Do NOT unhide on single feature removals; deletions/merges should keep server features hidden for the session
  useEffect(() => {
    const overlay = editor.getOverlayLayer();
    const source = overlay?.getSource();
    if (!source) return;
    const handleClear = () => {
      setHiddenIds(new Set());
    };
    // OL Source event names are strings; use 'any' cast for typing gap
    (source as unknown as { on: (n: string, h: () => void) => void }).on("clear", handleClear);
    return () => {
      (source as unknown as { un: (n: string, h: () => void) => void }).un("clear", handleClear);
    };
  }, [editor]);

  // Unified pointermove: prefer overlay hover; otherwise compute server-layer hover. Throttled via rAF and paused during AI.
  useEffect(() => {
    if (!mapRef.current || !serverLayerRef.current) return;
    const map = mapRef.current;
    let raf = 0;
    const onMove = (evt: MapBrowserEvent<UIEvent>) => {
      if (ai.isProcessing || ai.isActive) return;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // If overlay is hovered, clear server hover and exit
        let overlayHit = false;
        const overlay = editor.getOverlayLayer();
        if (overlay) {
          map.forEachFeatureAtPixel(
            evt.pixel,
            (_f, layer) => {
              if (layer === overlay) {
                overlayHit = true;
                return true;
              }
              return false;
            },
            { hitTolerance: 4 },
          );
        }
        if (overlayHit) {
          if (hoveredServerId !== null) setHoveredServerId(null);
          return;
        }
        let hovered: string | number | null = null;
        map.forEachFeatureAtPixel(
          evt.pixel,
          (f, layer) => {
            // Guard that feature has a get method
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            if (layer === serverLayerRef.current && f && typeof (f as Feature<Geometry>).get === "function") {
              const idVal = (f as Feature<Geometry>).get("id");
              if (idVal !== undefined && !hiddenIds.has(idVal)) hovered = idVal as string | number;
              return true;
            }
            return false;
          },
          { hitTolerance: 4 },
        );
        if (hovered !== hoveredServerId) setHoveredServerId(hovered);
      });
    };
    map.on("pointermove", onMove);
    return () => {
      map.un("pointermove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [activeLayer, dataset, hiddenIds, editor, ai.isProcessing, ai.isActive, hoveredServerId]);

  if (!dataset) {
    return <div className="p-4">Loading dataset...</div>;
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between p-2">
        <div className="flex items-center gap-2">
          <Button size="large" shape="circle" onClick={() => navigate(-1)} icon={<ArrowLeftOutlined />} />
          <div className="text-lg font-medium">Label Editor — Dataset {dataset.id}</div>
        </div>
        <div />
      </div>
      <div className="relative flex-1">
        <div ref={mapContainerRef} className="absolute inset-0" />
        {/* Top-left compact toolbar */}
        {editor.isEditing ? (
          <div className="pointer-events-auto absolute right-2 top-2 z-10 rounded bg-white/90 p-1 shadow">
            <Space size="small" wrap>
              {/* Draw controls */}
              {!editor.isDrawing && (
                <Button size="small" onClick={() => editor.toggleDraw(true)}>
                  Draw
                </Button>
              )}
              {editor.isDrawing && (
                <Button size="small" onClick={() => editor.toggleDraw(false)}>
                  Stop Draw
                </Button>
              )}

              {/* Segment only when map/AI ready */}
              {!ai.isActive && !ai.isProcessing && ai.canUse && (
                <Button size="small" onClick={ai.enable}>
                  Segment (Box)
                </Button>
              )}

              {/* Selection ops (hide when not applicable) */}
              {editor.selection.length === 1 && (
                <>
                  <Button size="small" onClick={editor.cutHoleWithDrawn}>
                    Cut Hole
                  </Button>
                  <Button size="small" onClick={editor.deleteSelected}>
                    Delete Selected
                  </Button>
                </>
              )}
              {editor.selection.length === 2 && (
                <>
                  <Button size="small" onClick={editor.mergeSelected}>
                    Merge
                  </Button>
                  <Button size="small" onClick={editor.deleteSelected}>
                    Delete Selected
                  </Button>
                </>
              )}

              {/* Session ops */}
              <Button size="small" onClick={editor.clearAll}>
                Clear All
              </Button>
              <Button danger size="small" onClick={editor.stopEditing}>
                Exit Edit
              </Button>
            </Space>
          </div>
        ) : (
          <div className="pointer-events-auto absolute right-2 top-2 z-10 rounded bg-white/90 p-1 shadow">
            <Button type="primary" onClick={editor.startEditing} size="small">
              Start Editing
            </Button>
          </div>
        )}

        {/* Layer selector (top-left like in DatasetDetailsMap) */}
        <div className="pointer-events-auto absolute left-2 top-4 z-10 rounded bg-white/90 p-1 shadow">
          <Radio.Group
            value={activeLayer}
            onChange={(e) => setActiveLayer(e.target.value as "deadwood" | "forest_cover")}
            size="small"
          >
            <Radio.Button value="deadwood">Deadwood</Radio.Button>
            <Radio.Button value="forest_cover">Forest cover</Radio.Button>
          </Radio.Group>
        </div>
      </div>
    </div>
  );
}
