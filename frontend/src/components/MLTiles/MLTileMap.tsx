import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import { Map, View } from "ol";
import { defaults as defaultInteractions } from "ol/interaction/defaults";
import TileLayerWebGL from "ol/layer/WebGLTile";
import { GeoTIFF } from "ol/source";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import VectorTileLayer from "ol/layer/VectorTile";
import type BaseLayer from "ol/layer/Base";
import { Style, Stroke } from "ol/style";
import Feature from "ol/Feature";
import { Polygon } from "ol/geom";
import GeoJSON from "ol/format/GeoJSON";
import { Translate, Select } from "ol/interaction";
import { click } from "ol/events/condition";
import { polygon as turfPolygon, multiPolygon as turfMultiPolygon, intersect, area } from "@turf/turf";
import { useUpdateTileGeometry } from "../../hooks/useMLTiles";
import "ol/ol.css";
import { message, Checkbox, Space } from "antd";
import { IMLTile, TileResolution } from "../../types/mlTiles";
import { useDatasetAOI } from "../../hooks/useDatasetAudit";
import { useDatasetLabelTypes } from "../../hooks/useDatasetLabelTypes";
import {
  createDeadwoodVectorLayer,
  createForestCoverVectorLayer,
  createAOIVectorLayer,
  createAOIMaskLayer,
} from "../DatasetDetailsMap/createVectorLayer";
import { Settings } from "../../config";
import { createOpenFreeMapLibertyLayerGroup } from "../../utils/basemaps";
import { palette } from "../../theme/palette";

interface Props {
  datasetId: number;
  cogPath?: string | null;
  resolution?: TileResolution;
  tiles: IMLTile[] | undefined;
  onTileSelected?: (tile: IMLTile | null) => void;
  focusTileId?: number | null;
  enableTranslation?: boolean;
  onGetTileGeometry?: (getter: (tileId: number) => GeoJSON.Polygon | null) => void;
  onGetLayerToggles?: (toggles: {
    toggleAOI: () => void;
    toggleDeadwood: () => void;
    toggleForestCover: () => void;
  }) => void;
}

const TARGET_TILE_SIZE_M: Record<TileResolution, number> = {
  20: 204.8,
  10: 102.4,
  5: 51.2,
};

export default function MLTileMap({
  datasetId,
  cogPath,
  resolution = 20,
  tiles,
  onTileSelected,
  focusTileId,
  enableTranslation = false,
  onGetTileGeometry,
  onGetLayerToggles,
}: Props) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);

  // Layer visibility state
  const [showAOI, setShowAOI] = useState(true);
  const [showDeadwood, setShowDeadwood] = useState(true);
  const [showForestCover, setShowForestCover] = useState(true);
  const tileLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const orthoLayerRef = useRef<TileLayerWebGL | null>(null);
  const aoiLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const aoiMaskLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const deadwoodLayerRef = useRef<VectorTileLayer | null>(null);
  const forestCoverLayerRef = useRef<VectorTileLayer | null>(null);
  const translateRef = useRef<Translate | null>(null);
  const selectRef = useRef<Select | null>(null);
  const hasInitialFitRef = useRef<boolean>(false);
  const tilesRef = useRef<IMLTile[] | undefined>(tiles);
  const previousFocusTileIdRef = useRef<number | null>(null);
  const { mutate: updateTileGeometry } = useUpdateTileGeometry();
  const { data: aoiData } = useDatasetAOI(datasetId);

  // Fetch label types for predictions
  const { deadwood, forestCover } = useDatasetLabelTypes({
    datasetId,
    enabled: !!datasetId,
  });

  // Keep tilesRef in sync with tiles prop
  useEffect(() => {
    tilesRef.current = tiles;
  }, [tiles]);

  const geoJsonFormatter = useMemo(() => new GeoJSON(), []);
  const aoiGeometry = useMemo(() => {
    if (!aoiData?.geometry) return null;
    try {
      return geoJsonFormatter.readGeometry(aoiData.geometry, {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      });
    } catch (err) {
      console.warn("Failed to parse AOI geometry", err);
      return null;
    }
  }, [aoiData?.geometry, geoJsonFormatter]);

  const aoiTurf = useMemo(() => {
    if (!aoiGeometry) return null;
    const geoObject = geoJsonFormatter.writeGeometryObject(aoiGeometry) as GeoJSON.Geometry;
    if (geoObject.type === "Polygon") {
      return turfPolygon(geoObject.coordinates as GeoJSON.Position[][]);
    }
    if (geoObject.type === "MultiPolygon") {
      return turfMultiPolygon(geoObject.coordinates as GeoJSON.Position[][][]);
    }
    return null;
  }, [aoiGeometry, geoJsonFormatter]);

  const validatePlacementAgainstAOI = useCallback(
    (tileGeom: GeoJSON.Polygon) => {
      if (!aoiTurf) return { ok: true, overlapPercent: null };
      const tilePoly = turfPolygon(tileGeom.coordinates as GeoJSON.Position[][]);
      // @ts-expect-error - turf types are incompatible but runtime works correctly
      const overlap = intersect(tilePoly, aoiTurf);
      if (!overlap) {
        return { ok: false, message: "Tile must intersect the AOI." };
      }
      const overlapPercent = (area(overlap) / area(tilePoly)) * 100;
      if (overlapPercent < 60) {
        return { ok: false, message: `AOI coverage is ${overlapPercent.toFixed(1)}%. Minimum is 60%.` };
      }
      return { ok: true, overlapPercent };
    },
    [aoiTurf],
  );

  const hasOverlapWithExistingTiles = useCallback(
    (tileGeom: GeoJSON.Polygon, excludeId?: number) => {
      if (!tiles?.length) return false;
      const candidate = turfPolygon(tileGeom.coordinates as GeoJSON.Position[][]);
      return tiles.some((t) => {
        if (excludeId && t.id === excludeId) return false;
        const existing = turfPolygon((t.geometry as GeoJSON.Polygon).coordinates as GeoJSON.Position[][]);
        // @ts-expect-error - turf types are incompatible but runtime works correctly
        return !!intersect(candidate, existing);
      });
    },
    [tiles],
  );

  // Initialize OL map and vector layers
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const basemap = createOpenFreeMapLibertyLayerGroup();

    const vector = new VectorLayer({
      source: new VectorSource(),
      style: (feature) => {
        const status = feature.get("status") as string;
        const isSelected = feature.get("isSelected") as boolean;
        let strokeColor = palette.state.pending;
        let strokeWidth = 3; // Thicker borders for better visibility

        if (status === "good") {
          strokeColor = palette.state.success;
        } else if (status === "bad") {
          strokeColor = palette.state.error;
        }

        // Highlight selected tile with thicker blue border
        if (isSelected) {
          strokeColor = palette.primary[500];
          strokeWidth = 5; // Extra thick for selected tile
        }

        return new Style({
          stroke: new Stroke({ color: strokeColor, width: strokeWidth }),
        });
      },
    });

    const view = new View({
      center: [0, 0],
      zoom: 2,
      maxZoom: 22, // Allow zooming to tile level, but basemap stops at 19
      projection: "EPSG:3857",
    });

    const layers: BaseLayer[] = [basemap];
    if (cogPath) {
      const ortho = new TileLayerWebGL({
        source: new GeoTIFF({
          sources: [
            {
              url: Settings.COG_BASE_URL + cogPath,
              nodata: 0,
              bands: [1, 2, 3],
            },
          ],
          convertToRGB: true,
        }),
        maxZoom: 23,
        cacheSize: 1024,
        preload: 0,
      });
      orthoLayerRef.current = ortho;
      layers.push(ortho);
    }

    // AOI and prediction layers will be added dynamically via separate useEffect

    vector.setZIndex(100); // ML tiles on top of everything
    layers.push(vector);

    const map = new Map({
      target: mapContainerRef.current,
      layers,
      view,
      controls: [],
      interactions: defaultInteractions({ doubleClickZoom: false }),
    });

    setTimeout(() => map.updateSize(), 0);
    const handleResize = () => map.updateSize();
    window.addEventListener("resize", handleResize);
    const ro = new ResizeObserver(() => map.updateSize());
    ro.observe(mapContainerRef.current);

    const select = new Select({
      condition: click,
      layers: [vector],
      style: (feature) => {
        // Use the same style as the vector layer (no fill, just stroke)
        const status = feature.get("status") as string;
        const isSelected = feature.get("isSelected") as boolean;
        let strokeColor = palette.state.pending;
        let strokeWidth = 3;

        if (status === "good") {
          strokeColor = palette.state.success;
        } else if (status === "bad") {
          strokeColor = palette.state.error;
        }

        if (isSelected) {
          strokeColor = palette.primary[500];
          strokeWidth = 5;
        }

        return new Style({
          stroke: new Stroke({ color: strokeColor, width: strokeWidth }),
        });
      },
    });
    map.addInteraction(select);
    select.on("select", (e) => {
      const f = e.selected?.[0] as Feature<Polygon> | undefined;
      if (!f) {
        onTileSelected?.(null);
        return;
      }
      const tileId = f.get("tileId") as number | undefined;
      // Use tilesRef.current to access the latest tiles array
      const tile = tilesRef.current?.find((t) => t.id === tileId) || null;
      onTileSelected?.(tile || null);
    });
    selectRef.current = select;

    // Only enable translation if explicitly allowed and only for base tiles (20cm) with pending status
    const translate = new Translate({
      layers: [vector],
      filter: (feature) => {
        if (!enableTranslation) return false;
        // Use tilesRef.current to access the latest tiles array
        const tile = tilesRef.current?.find((t) => t.id === feature.get("tileId"));
        if (!tile) return false;
        // Only allow translation of base tiles (20cm) that are pending
        return tile.resolution_cm === 20 && tile.status === "pending";
      },
    });
    map.addInteraction(translate);
    translate.on("translateend", (evt) => {
      const feature = evt.features?.item(0) as Feature<Polygon> | undefined;
      if (!feature) return;
      const tileId = feature.get("tileId") as number | undefined;
      if (!tileId) return;
      const geom = feature.getGeometry();
      if (!geom) return;

      const corrected = enforceTileDimensions(geom as Polygon, resolution);
      feature.setGeometry(corrected);
      const gjCorrected = geoJsonFormatter.writeGeometryObject(corrected) as GeoJSON.Polygon;

      const placementValidation = validatePlacementAgainstAOI(gjCorrected);
      if (!placementValidation.ok) {
        message.error(placementValidation.message || "Tile placement invalid");
        return;
      }
      if (hasOverlapWithExistingTiles(gjCorrected, tileId)) {
        message.error("Tile overlaps an existing tile");
        return;
      }

      updateTileGeometry({
        tileId,
        geometry: gjCorrected,
        bbox: polygonToBBoxShort(gjCorrected),
        aoiCoveragePercent: placementValidation.overlapPercent ? Math.round(placementValidation.overlapPercent) : null,
      });
      // Use tilesRef.current to access the latest tiles array
      onTileSelected?.(tilesRef.current?.find((t) => t.id === tileId) || null);
    });

    mapRef.current = map;
    tileLayerRef.current = vector;
    translateRef.current = translate;

    return () => {
      map.setTarget(undefined);
      window.removeEventListener("resize", handleResize);
      ro.disconnect();
      mapRef.current = null;
      tileLayerRef.current = null;
      translateRef.current = null;
      selectRef.current = null;
      aoiLayerRef.current = null;
      aoiMaskLayerRef.current = null;
      deadwoodLayerRef.current = null;
      forestCoverLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only initialize map once on mount

  // Expose function to get current tile geometry from map (run once on mount)
  useEffect(() => {
    if (!onGetTileGeometry) return;

    const getTileGeometry = (tileId: number): GeoJSON.Polygon | null => {
      const layer = tileLayerRef.current;
      if (!layer) return null;
      const src = layer.getSource();
      if (!src) return null;

      const feature = src.getFeatures().find((f) => f.get("tileId") === tileId);
      if (!feature) return null;

      const geom = feature.getGeometry();
      if (!geom) return null;

      // Create formatter on demand to avoid closure issues
      const formatter = new GeoJSON();
      return formatter.writeGeometryObject(geom) as GeoJSON.Polygon;
    };

    // Call the parent's callback with our getter function once
    onGetTileGeometry(getTileGeometry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount - the getter uses refs so it always accesses latest state

  // Expose layer toggle functions (run once on mount)
  useEffect(() => {
    if (!onGetLayerToggles) return;

    const toggles = {
      toggleAOI: () => setShowAOI((prev) => !prev),
      toggleDeadwood: () => setShowDeadwood((prev) => !prev),
      toggleForestCover: () => setShowForestCover((prev) => !prev),
    };

    // Call the parent's callback with toggle functions once
    onGetLayerToggles(toggles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount - uses state setters which are stable

  // Render features when tiles change
  useEffect(() => {
    const layer = tileLayerRef.current;
    const map = mapRef.current;
    if (!layer || !map) return;
    const src = layer.getSource();
    if (!src) return;

    // Get existing features
    const existingFeatures = src.getFeatures();
    const newIds = new Set((tiles || []).map((t) => t.id));

    // Remove features that no longer exist
    existingFeatures.forEach((f) => {
      const tileId = f.get("tileId");
      if (!newIds.has(tileId)) {
        src.removeFeature(f);
      }
    });

    // Update existing features and add new ones
    (tiles || []).forEach((t) => {
      const existingFeature = existingFeatures.find((f) => f.get("tileId") === t.id);

      if (existingFeature) {
        // Update existing feature properties
        existingFeature.set("status", t.status);
        // Geometry shouldn't change, but status might
      } else {
        // Add new feature
        const feature = new Feature({
          geometry: geoJsonFormatter.readGeometry(t.geometry, {
            dataProjection: "EPSG:3857",
            featureProjection: "EPSG:3857",
          }) as Polygon,
        });
        feature.set("tileId", t.id);
        feature.set("status", t.status);
        src.addFeature(feature);
      }
    });

    // Only auto-fit on first load if tiles exist and we haven't done initial fit yet
    if (tiles && tiles.length > 0 && !hasInitialFitRef.current) {
      const extent = src.getExtent();
      map.getView().fit(extent, { padding: [50, 50, 50, 50], maxZoom: 18, duration: 500 });
      hasInitialFitRef.current = true;
    }
  }, [tiles, geoJsonFormatter]);

  // Memoize the label IDs to only trigger layer recreation when IDs actually change
  const forestCoverId = useMemo(() => forestCover.data?.id, [forestCover.data?.id]);
  const deadwoodId = useMemo(() => deadwood.data?.id, [deadwood.data?.id]);

  // Add/update prediction layers when label IDs change
  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;

    // Remove existing prediction layers
    if (forestCoverLayerRef.current) {
      map.removeLayer(forestCoverLayerRef.current);
      forestCoverLayerRef.current = null;
    }
    if (deadwoodLayerRef.current) {
      map.removeLayer(deadwoodLayerRef.current);
      deadwoodLayerRef.current = null;
    }

    // Add forest cover prediction layer if available (z-index 12)
    if (forestCoverId) {
      const forestCoverLayer = createForestCoverVectorLayer(forestCoverId);
      if (forestCoverLayer) {
        forestCoverLayer.setZIndex(12); // Above AOI layers
        forestCoverLayerRef.current = forestCoverLayer;
        map.addLayer(forestCoverLayer);
        // Visibility will be set by the separate toggle effect
      }
    }

    // Add deadwood prediction layer if available (z-index 13)
    if (deadwoodId) {
      const deadwoodLayer = createDeadwoodVectorLayer(deadwoodId);
      if (deadwoodLayer) {
        deadwoodLayer.setZIndex(13); // Above forest cover
        deadwoodLayerRef.current = deadwoodLayer;
        map.addLayer(deadwoodLayer);
        // Visibility will be set by the separate toggle effect
      }
    }
  }, [forestCoverId, deadwoodId]);

  // Toggle deadwood prediction layer visibility
  useEffect(() => {
    if (deadwoodLayerRef.current) {
      deadwoodLayerRef.current.setVisible(showDeadwood);
    }
  }, [showDeadwood]);

  // Toggle forest cover prediction layer visibility
  useEffect(() => {
    if (forestCoverLayerRef.current) {
      forestCoverLayerRef.current.setVisible(showForestCover);
    }
  }, [showForestCover]);

  // Add/update AOI layers when geometry becomes available
  useEffect(() => {
    if (!mapRef.current || !aoiData?.geometry) return;
    const map = mapRef.current;

    // Remove existing AOI layers if they exist
    if (aoiLayerRef.current) {
      map.removeLayer(aoiLayerRef.current);
      aoiLayerRef.current = null;
    }
    if (aoiMaskLayerRef.current) {
      map.removeLayer(aoiMaskLayerRef.current);
      aoiMaskLayerRef.current = null;
    }

    // Use the original geometry from aoiData (in EPSG:4326)
    // The helper functions handle the coordinate transformation internally
    const aoiGeoJSON = aoiData.geometry as GeoJSON.MultiPolygon | GeoJSON.Polygon;

    // Create and add mask layer (grays out areas outside AOI)
    const aoiMaskLayer = createAOIMaskLayer(aoiGeoJSON);
    if (aoiMaskLayer) {
      aoiMaskLayerRef.current = aoiMaskLayer;
      aoiMaskLayer.setVisible(showAOI);
      aoiMaskLayer.setZIndex(10); // Lowest prediction layer
      map.addLayer(aoiMaskLayer);
    }

    // Create and add AOI boundary layer
    const aoiLayer = createAOIVectorLayer(aoiGeoJSON);
    if (aoiLayer) {
      aoiLayerRef.current = aoiLayer;
      aoiLayer.setVisible(showAOI);
      aoiLayer.setZIndex(11); // Just above mask
      map.addLayer(aoiLayer);
    }
  }, [aoiData?.geometry, showAOI]);

  // Fit view to ortho extent
  useEffect(() => {
    if (!mapRef.current || !orthoLayerRef.current) return;
    const map = mapRef.current;
    const source = orthoLayerRef.current.getSource();
    source
      ?.getView()
      .then((vo) => {
        const viewOptions = vo as { extent?: [number, number, number, number] };
        if (viewOptions?.extent) {
          map.getView().fit(viewOptions.extent, { padding: [20, 20, 20, 20], maxZoom: 19, duration: 200 });
        }
      })
      .catch(() => {});
  }, [cogPath]);

  // Zoom to specific tile and sync selection when focusTileId changes
  useEffect(() => {
    if (!mapRef.current) return;

    const select = selectRef.current;
    const layer = tileLayerRef.current;

    // If focusTileId is null, clear selection
    if (!focusTileId) {
      if (select) {
        select.getFeatures().clear();
      }
      if (layer) {
        const src = layer.getSource();
        if (src) {
          // Clear isSelected property on all features
          src.getFeatures().forEach((f) => f.set("isSelected", false));
        }
      }
      previousFocusTileIdRef.current = null;
      return;
    }

    // Only zoom if focusTileId actually changed
    if (previousFocusTileIdRef.current === focusTileId) return;

    // Use tilesRef to get current tiles without triggering on tiles changes
    const tiles = tilesRef.current;
    if (!tiles) return;

    const tile = tiles.find((t) => t.id === focusTileId);
    if (!tile) return;

    // Sync the OpenLayers Select interaction with focusTileId
    if (select && layer) {
      const src = layer.getSource();
      if (src) {
        // Find the feature with matching tileId
        const features = src.getFeatures();
        const featureToSelect = features.find((f) => f.get("tileId") === focusTileId);

        if (featureToSelect) {
          // Clear current selection and select the new feature
          select.getFeatures().clear();
          select.getFeatures().push(featureToSelect);

          // Update isSelected property on all features
          features.forEach((f) => {
            f.set("isSelected", f.get("tileId") === focusTileId);
          });
        }
      }
    }

    try {
      const geometry = geoJsonFormatter.readGeometry(tile.geometry, {
        dataProjection: "EPSG:3857",
        featureProjection: "EPSG:3857",
      });
      const extent = geometry.getExtent();
      const view = mapRef.current.getView();

      // Use fit with padding for smooth animation
      view.fit(extent, {
        padding: [30, 30, 30, 30], // Reduced padding for closer zoom
        maxZoom: 22, // Increased max zoom level for smaller tiles
        duration: 400,
      });

      // Update the previous focus tile ID after zooming
      previousFocusTileIdRef.current = focusTileId;
    } catch (error) {
      console.error("Failed to zoom to tile:", error);
    }
  }, [focusTileId, geoJsonFormatter]);

  // Toggle AOI layer visibility (both boundary and mask)
  useEffect(() => {
    if (aoiLayerRef.current) {
      aoiLayerRef.current.setVisible(showAOI);
    }
    if (aoiMaskLayerRef.current) {
      aoiMaskLayerRef.current.setVisible(showAOI);
    }
  }, [showAOI]);

  return (
    <div className="relative h-full w-full">
      <div ref={mapContainerRef} className="h-full w-full bg-gray-100" />

      {/* Layer visibility controls */}
      <div className="absolute bottom-2 left-2 z-10 rounded bg-white/90 p-2 shadow">
        <Space direction="vertical" size="small">
          {aoiData?.geometry && (
            <Checkbox checked={showAOI} onChange={(e) => setShowAOI(e.target.checked)}>
              AOI <span className="text-xs text-gray-500">(J)</span>
            </Checkbox>
          )}
          {deadwood.data?.id && (
            <Checkbox checked={showDeadwood} onChange={(e) => setShowDeadwood(e.target.checked)}>
              Deadwood <span className="text-xs text-gray-500">(K)</span>
            </Checkbox>
          )}
          {forestCover.data?.id && (
            <Checkbox checked={showForestCover} onChange={(e) => setShowForestCover(e.target.checked)}>
              Forest Cover <span className="text-xs text-gray-500">(L)</span>
            </Checkbox>
          )}
        </Space>
      </div>
    </div>
  );
}

function enforceTileDimensions(geometry: Polygon, resolution: TileResolution): Polygon {
  const size = TARGET_TILE_SIZE_M[resolution];
  const extent = geometry.getExtent();
  const cx = (extent[0] + extent[2]) / 2;
  const cy = (extent[1] + extent[3]) / 2;
  const half = size / 2;
  return new Polygon([
    [
      [cx - half, cy - half],
      [cx + half, cy - half],
      [cx + half, cy + half],
      [cx - half, cy + half],
      [cx - half, cy - half],
    ],
  ]);
}

function polygonToBBoxShort(geometry: GeoJSON.Polygon): { minx: number; miny: number; maxx: number; maxy: number } {
  const coords = geometry.coordinates[0];
  const [minx, miny] = coords[0];
  const [maxx, maxy] = coords[2];
  return { minx, miny, maxx, maxy };
}
