import VectorTileLayer from "ol/layer/VectorTile";
import VectorTileSource from "ol/source/VectorTile";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Fill, Stroke, Style } from "ol/style";
import MVT from "ol/format/MVT";
import GeoJSON from "ol/format/GeoJSON";
import { Polygon } from "ol/geom";
import type Geometry from "ol/geom/Geometry";
import { supabase } from "../../hooks/useSupabase";
import { base64ToArrayBuffer } from "../../utils/base64ToArrayBuffer";
import Feature from "ol/Feature";
import VectorTile from "ol/VectorTile";
import type { FeatureLike } from "ol/Feature";
import { palette } from "../../theme/palette";
import { mapColors } from "../../theme/mapColors";

interface VectorLayerConfig {
  rpcFunctionName: string;
  className: string;
  style: {
    fillColor: string;
    strokeColor: string;
    strokeWidth: number;
  };
  labelId?: number | null;
  filterCorrectionStatus?: string | null; // 'all', 'pending', or null (default)
  showCorrectionStyling?: boolean; // Enable different colors for pending/deleted
}

const createVectorLayer = (config: VectorLayerConfig) => {
  const vectorSource = new VectorTileSource<Feature<Geometry>>({
    format: new MVT<Feature<Geometry>>({
      featureClass: Feature,
      geometryName: "geom",
    }),
    tileLoadFunction: async (tile, url) => {
      const vectorTile = tile as VectorTile<Feature<Geometry>>;
      const [z, x, y] = url.split("/").slice(-3).map(Number);
      // console.log(`[Tile Request] z=${z}, x=${x}, y=${y}`);
      // Skip API call completely if no labelId is provided
      if (!config.labelId) {
        // Set empty features for the tile when no label ID exists
        vectorTile.setFeatures([]);
        return;
      }

      try {
        const rpcParams: Record<string, unknown> = {
          z,
          x,
          y,
          resolution: 4096,
          filter_label_id: config.labelId || null,
        };
        // Add correction filter if using correction-aware functions
        if (config.rpcFunctionName.includes("_with_corrections")) {
          rpcParams.filter_correction_status = config.filterCorrectionStatus || null;
        }
        const { data, error } = await supabase.rpc(config.rpcFunctionName, rpcParams);
        // const fetchTime = performance.now() - startTime;

        if (error) throw error;

        // A tile with no polygons in it comes back as an empty string.
        if (data === "") {
          vectorTile.setFeatures([]);
          return;
        }

        if (data) {
          // console.log(`[Tile Success] z=${z}, x=${x}, y=${y}, fetch=${fetchTime.toFixed(0)}ms`);
          // const decodeStart = performance.now();
          const uint8Array = base64ToArrayBuffer(data);
          const format = vectorTile.getFormat();

          const features = format.readFeatures(uint8Array, {
            extent: vectorTile.extent,
            featureProjection: "EPSG:3857",
          });

          // Log any extremely large features that might cause issues
          // features.forEach((feature, i) => {
          //   const geom = feature.getGeometry();
          //   if (geom && geom.getType() === "Polygon") {
          //     const coords = geom.getCoordinates();
          //     if (coords[0] && coords[0].length > 1000) {
          //       console.warn(`[Large Geometry] z=${z}, x=${x}, y=${y}, feature=${i}, vertices=${coords[0].length}`);
          //     }
          //   }
          // });

          vectorTile.setFeatures(features);
        } else {
          tile.setState(3); // ERROR
        }
      } catch (err) {
        console.error(`[Tile Error] z=${z}, x=${x}, y=${y}:`, err);
        tile.setState(3); // ERROR
      }
    },
    url: `${config.className}/{z}/{x}/{y}`,
    // Deeper zooms reuse the z19 tiles. Their 4096-unit grid is 1.9 cm, finer
    // than the 5 cm prediction raster and about one screen pixel at maximum
    // zoom, so the polygons look the same and zooming in fetches nothing new.
    maxZoom: 19,
    tileSize: 512,
    cacheSize: 2048, // Increased cache for better performance
    transition: 0, // Disable transition for instant rendering
  });

  // A tile can hold thousands of polygons and is restyled on every redraw, so
  // the few distinct styles are built once per layer and reused.
  const hiddenStyle = new Style({}); // Empty style = invisible
  const pendingDeleteStyle = new Style({
    fill: new Fill({ color: "rgba(239, 68, 68, 0.3)" }), // Light red fill
    stroke: new Stroke({
      color: palette.state.error,
      width: 2,
      lineDash: [6, 4], // Dashed line to indicate pending deletion
    }),
  });
  const outlineStyle = (strokeColor: string, strokeWidth: number) =>
    new Style({
      fill: new Fill({ color: config.style.fillColor }),
      stroke: new Stroke({ color: strokeColor, width: strokeWidth }),
    });
  // Corrections keep the original fill and only change the border.
  const defaultStyle = outlineStyle(config.style.strokeColor, config.style.strokeWidth);
  const pendingStyle = outlineStyle(palette.primary[500], 2); // subtle blue border
  const approvedStyle = outlineStyle(palette.forest[600], 2); // subtle green border

  // Correction status is only present in the corrections-aware MVT.
  const getFeatureStyle = (feature: FeatureLike) => {
    const correctionStatus = feature.get("correction_status") as string | undefined;
    const correctionOperation = feature.get("correction_operation") as string | undefined;
    const isDeleted = feature.get("is_deleted") as boolean | undefined;

    if (isDeleted) {
      // Auditors see pending deletions; everyone else does not see deleted polygons.
      return config.showCorrectionStyling && correctionStatus === "pending" && correctionOperation === "delete"
        ? pendingDeleteStyle
        : hiddenStyle;
    }
    if (config.showCorrectionStyling && correctionStatus === "pending") return pendingStyle;
    if (config.showCorrectionStyling && correctionStatus === "approved") return approvedStyle;
    // 'none' or 'rejected' use default style (original predictions)
    return defaultStyle;
  };

  const vectorLayer = new VectorTileLayer({
    source: vectorSource,
    style: getFeatureStyle,
    maxZoom: 23,
    className: config.className,
    renderMode: "hybrid", // Polygons are drawn into tile images once, not on every frame
    renderBuffer: 64, // Reduced from 256 for faster rendering
    declutter: false,
    updateWhileAnimating: true, // Enable smooth updates during animation
    updateWhileInteracting: true, // Enable smooth updates during panning/zooming
    useInterimTilesOnError: true,
    // No lower-zoom preload: those tiles hold the most polygons, are the slowest
    // to build, and while they load they hold slots of the map's shared tile
    // budget that the drone imagery then waits for.
  });

  return vectorLayer;
};

interface LayerOptions {
  showCorrectionStyling?: boolean;
  filterCorrectionStatus?: string | null;
}

export const createDeadwoodVectorLayer = (labelId?: number | null, options?: LayerOptions) =>
  createVectorLayer({
    // Use original perf function for default, corrections-aware function when styling requested
    rpcFunctionName: options?.showCorrectionStyling 
      ? "get_deadwood_tiles_with_corrections" 
      : "get_deadwood_vector_tiles_perf1",
    className: "deadwood-vector",
    style: {
      fillColor: "rgba(255, 179, 28, 0.7)",
      strokeColor: mapColors.deadwood.text,
      strokeWidth: 1.5,
    },
    labelId: labelId || undefined,
    showCorrectionStyling: options?.showCorrectionStyling,
    filterCorrectionStatus: options?.filterCorrectionStatus,
  });

export const createForestCoverVectorLayer = (labelId?: number, options?: LayerOptions) =>
  createVectorLayer({
    // Use original perf function for default, corrections-aware function when styling requested
    rpcFunctionName: options?.showCorrectionStyling 
      ? "get_forest_cover_tiles_with_corrections" 
      : "get_forest_cover_vector_tiles_perf",
    className: "forest-cover-vector",
    style: {
      fillColor: "rgba(34, 197, 94, 0.5)", // Green with high opacity
      strokeColor: mapColors.forest.fill,
      strokeWidth: 1,
    },
    labelId,
    showCorrectionStyling: options?.showCorrectionStyling,
    filterCorrectionStatus: options?.filterCorrectionStatus,
  });

export const createAOIVectorLayer = (geometry: GeoJSON.MultiPolygon | GeoJSON.Polygon) => {
  const aoiSource = new VectorSource();
  const format = new GeoJSON();

  try {
    // Handle MultiPolygon by creating separate features for each polygon
    if (geometry.type === "MultiPolygon") {
      geometry.coordinates.forEach((polygonCoords) => {
        const polygonGeometry: GeoJSON.Polygon = {
          type: "Polygon",
          coordinates: polygonCoords,
        };

        const feature = format.readFeature(polygonGeometry, {
          dataProjection: "EPSG:4326",
          featureProjection: "EPSG:3857",
        });

        if (feature && !Array.isArray(feature) && feature.getGeometry()) {
          aoiSource.addFeature(feature);
        }
      });
    } else if (geometry.type === "Polygon") {
      // Handle single Polygon
      const feature = format.readFeature(geometry, {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      });

      if (feature && !Array.isArray(feature) && feature.getGeometry()) {
        aoiSource.addFeature(feature);
      }
    }
  } catch (error) {
    console.error("Error processing AOI geometry:", error);
  }

  return new VectorLayer({
    source: aoiSource,
    style: new Style({
      stroke: new Stroke({
        color: mapColors.aoi.stroke,
        width: 2,
      }),
      fill: new Fill({
        color: "rgba(0, 0, 0, 0)",
      }),
    }),
    className: "aoi-vector",
  });
};

export const createAOIMaskLayer = (geometry: GeoJSON.MultiPolygon | GeoJSON.Polygon) => {
  const maskSource = new VectorSource();
  const format = new GeoJSON();

  try {
    // Create a large polygon covering the entire world
    const worldExtent = [-20037508, -20037508, 20037508, 20037508]; // Web Mercator world bounds

    // Convert AOI geometry to Web Mercator coordinates for hole creation
    const holes: number[][][] = [];

    if (geometry.type === "MultiPolygon") {
      // For MultiPolygon, each polygon becomes a hole
      geometry.coordinates.forEach((polygonCoords) => {
        const polygonGeometry: GeoJSON.Polygon = {
          type: "Polygon",
          coordinates: polygonCoords,
        };

        const tempFeature = format.readFeature(polygonGeometry, {
          dataProjection: "EPSG:4326",
          featureProjection: "EPSG:3857",
        });

        if (tempFeature && !Array.isArray(tempFeature)) {
          const geom = tempFeature.getGeometry();
          if (geom && geom.getType() === "Polygon") {
            // @ts-expect-error - OpenLayers Polygon type
            const coords = geom.getCoordinates();
            if (coords && coords[0]) {
              holes.push(coords[0]);
            }
          }
        }
      });
    } else if (geometry.type === "Polygon") {
      // For single Polygon, it becomes the hole
      const tempFeature = format.readFeature(geometry, {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      });

      if (tempFeature && !Array.isArray(tempFeature)) {
        const geom = tempFeature.getGeometry();
        if (geom && geom.getType() === "Polygon") {
          // @ts-expect-error - OpenLayers Polygon type
          const coords = geom.getCoordinates();
          if (coords && coords[0]) {
            holes.push(coords[0]);
          }
        }
      }
    }

    // Create the mask polygon: world extent with AOI holes
    const maskCoordinates = [
      [
        [worldExtent[0], worldExtent[1]], // bottom-left
        [worldExtent[2], worldExtent[1]], // bottom-right
        [worldExtent[2], worldExtent[3]], // top-right
        [worldExtent[0], worldExtent[3]], // top-left
        [worldExtent[0], worldExtent[1]], // close
      ],
      ...holes, // Add all AOI areas as holes
    ];

    // Create the mask feature directly in Web Mercator
    const maskFeature = new Feature({
      geometry: new Polygon(maskCoordinates),
    });

    maskSource.addFeature(maskFeature);
  } catch (error) {
    console.error("Error creating AOI mask:", error);
  }

  return new VectorLayer({
    source: maskSource,
    style: new Style({
      fill: new Fill({
        color: "rgba(0, 0, 0, 0.5)", // Stronger black mask for better focus effect
      }),
      stroke: new Stroke({
        color: "transparent",
        width: 0,
      }),
    }),
    className: "aoi-mask",
  });
};
