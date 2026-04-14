import VectorTileLayer from "ol/layer/VectorTile";
import VectorTileSource from "ol/source/VectorTile";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Fill, Stroke, Style } from "ol/style";
import MVT from "ol/format/MVT";
import GeoJSON from "ol/format/GeoJSON";
import { Polygon } from "ol/geom";
import { supabase } from "../../hooks/useSupabase";
import { base64ToArrayBuffer } from "../../utils/base64ToArrayBuffer";
import Feature from "ol/Feature";
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
  const vectorSource = new VectorTileSource({
    format: new MVT({
      featureClass: Feature,
      geometryName: "geom",
    }),
    tileLoadFunction: async (tile, url) => {
      const [z, x, y] = url.split("/").slice(-3).map(Number);
      // console.log(`[Tile Request] z=${z}, x=${x}, y=${y}`);
      // Skip API call completely if no labelId is provided
      if (!config.labelId) {
        // Set empty features for the tile when no label ID exists
        tile.setFeatures([]);
        return;
      }

      try {
        const startTime = performance.now();
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

        if (data) {
          // console.log(`[Tile Success] z=${z}, x=${x}, y=${y}, fetch=${fetchTime.toFixed(0)}ms`);
          // const decodeStart = performance.now();
          const uint8Array = base64ToArrayBuffer(data);
          const format = tile.getFormat();

          const features = format.readFeatures(uint8Array, {
            extent: tile.extent,
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

          tile.setFeatures(features);
        } else {
          tile.setState(3); // ERROR
        }
      } catch (err) {
        console.error(`[Tile Error] z=${z}, x=${x}, y=${y}:`, err);
        tile.setState(3); // ERROR
      }
    },
    url: `${config.className}/{z}/{x}/{y}`,
    maxZoom: 22,
    tileSize: 512,
    cacheSize: 2048, // Increased cache for better performance
    transition: 0, // Disable transition for instant rendering
  });

  // Create style function for correction-aware styling
  const getFeatureStyle = (feature: Feature) => {
    // Get correction status from feature properties (only available with corrections-aware MVT)
    const correctionStatus = feature.get("correction_status") as string | undefined;
    const correctionOperation = feature.get("correction_operation") as string | undefined;
    const isDeleted = feature.get("is_deleted") as boolean | undefined;

    // Handle deleted polygons
    if (isDeleted) {
      // Show pending delete corrections with special styling for auditors
      if (config.showCorrectionStyling && correctionStatus === "pending" && correctionOperation === "delete") {
        return new Style({
          fill: new Fill({ color: "rgba(239, 68, 68, 0.3)" }), // Light red fill
          stroke: new Stroke({ 
            color: palette.state.error,
            width: 2,
            lineDash: [6, 4], // Dashed line to indicate pending deletion
          }),
        });
      }
      // Hide deleted polygons from regular users
      return new Style({}); // Empty style = invisible
    }

    // Default style values - keep original fill, only change border for corrections
    let fillColor = config.style.fillColor;
    let strokeColor = config.style.strokeColor;
    let strokeWidth = config.style.strokeWidth;

    if (config.showCorrectionStyling && correctionStatus) {
      if (correctionStatus === "pending") {
        // Pending correction - keep original fill, subtle blue border
        strokeColor = palette.primary[500];
        strokeWidth = 2;
      } else if (correctionStatus === "approved") {
        // Approved correction - keep original fill, subtle green border
        strokeColor = palette.forest[600];
        strokeWidth = 2;
      }
      // 'none' or 'rejected' use default style (original predictions)
    }

    return new Style({
      fill: new Fill({ color: fillColor }),
      stroke: new Stroke({ color: strokeColor, width: strokeWidth }),
    });
  };

  const vectorLayer = new VectorTileLayer({
    source: vectorSource,
    style: getFeatureStyle,
    maxZoom: 23,
    className: config.className,
    renderMode: "hybrid", // Use hybrid mode for better performance (GPU acceleration)
    renderBuffer: 64, // Reduced from 256 for faster rendering
    declutter: false,
    updateWhileAnimating: true, // Enable smooth updates during animation
    updateWhileInteracting: true, // Enable smooth updates during panning/zooming
    useInterimTilesOnError: true,
    preload: 1, // Preload 1 level of adjacent tiles for smoother experience
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
