import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Drawer,
  Form,
  Input,
  message,
  Modal,
  Select,
} from "antd";
import {
  CheckOutlined,
  CloseOutlined,
  ExperimentOutlined,
  FlagOutlined,
  InfoCircleOutlined,
  SendOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import "ol/ol.css";
import { Map, Overlay } from "ol";
import { defaults as defaultInteractions } from "ol/interaction";
import { fromLonLat, transformExtent, toLonLat } from "ol/proj";
import LayerGroup from "ol/layer/Group";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { XYZ } from "ol/source";
import { GeoTIFF } from "ol/source";
import TileLayerWebGL from "ol/layer/WebGLTile.js";
import View from "ol/View";
import Feature from "ol/Feature";
import { Polygon, Point } from "ol/geom";
import { getCenter } from "ol/extent";
import { Draw } from "ol/interaction";
import { createBox } from "ol/interaction/Draw";
import { Style, Fill, Stroke, Circle as CircleStyle } from "ol/style";
import type { FeatureLike } from "ol/Feature";

import getPixelValueOfCoordinate from "../../utils/getPixelValueOfCoordinate";
import {
  getDeadwoodCOGUrl,
  getForestCOGUrl,
  type MapModelVersion,
} from "../../utils/getDeadwoodCOGUrl";
import {
  createOpenFreeMapLibertyLayerGroup,
  createStandardMapControls,
  createWaybackSource,
  createWaybackTileLayer,
} from "../../utils/basemaps";
import LayerControlPanel from "./LayerControlPanel";
import LocationControls from "./LocationControls";
import YearImagerySelector from "./YearImagerySelector";
import PolygonStatsModal from "./PolygonStatsModal";
import MobileAddTreeButton from "./mobile/MobileAddTreeButton";
import MobileAnalysisDrawer from "./mobile/MobileAnalysisDrawer";
import MobileLayerDrawer from "./mobile/MobileLayerDrawer";
import MobileTimeDrawer from "./mobile/MobileTimeDrawer";
import MobileTimePill from "./mobile/MobileTimePill";
import MobileMapControls from "./mobile/MobileMapControls";
import type { MobileMapPanel } from "./mobile/MobileMapControls";
import { useMobileImageryAutoSelect } from "./mobile/useMobileImageryAutoSelect";
import { useDatasetMap } from "../../hooks/useDatasetMapProvider";
import { useAuth } from "../../hooks/useAuthProvider";
import { useCanAudit } from "../../hooks/useUserPrivileges";
import { useMapFlags, useCreateMapFlag } from "../../hooks/useMapFlags";
import { useWaybackItemsDebounced } from "../../hooks/useWaybackItems";
import { usePolygonAnalysis } from "../../hooks/usePolygonAnalysis";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useUserLocationLayer } from "../../hooks/useUserLocationLayer";
import {
  getPublicTreeClientId,
  usePublicTreeObservations,
} from "../../hooks/usePublicTreeObservations";
import type { IMapFlag } from "../../types/mapFlags";
import type {
  PublicTreeCondition,
  PublicTreeObservationInput,
  PublicTreeTypeGroup,
} from "../../types/publicTreeObservations";
import {
  publicTreeConditionOptions,
  publicTreeTypeGroupOptions,
} from "../../types/publicTreeObservations";
import {
  createPublicTreeObservationLayer,
  syncPublicTreeObservationLayer,
} from "./createPublicTreeObservationLayer";
import { mapColors } from "../../theme/mapColors";
import { palette } from "../../theme/palette";
import { downloadPublicTreeObservationsCsv } from "../../utils/publicTreeObservationCsv";

const PREVIEW_WARNING_STORAGE_KEY = "deadtrees-preview-warning-shown";
const PREVIEW_WARNING_EVENT = "deadtrees:preview-warning-visibility";
type FlagDrawMode = "bbox" | "polygon";

interface ClickedValues {
  forestPct: number;
  deadwoodPct: number;
}

interface PublicTreeObservationFormValues {
  condition: PublicTreeCondition;
  treeTypeGroup: PublicTreeTypeGroup;
  treeTypeText?: string;
  comment?: string;
}

// Helper to create GeoTIFF source for deadwood
const createDeadwoodSource = (year: string, version: MapModelVersion) => {
  return new GeoTIFF({
    sources: [
      { url: getDeadwoodCOGUrl(year, version), bands: [1], min: 0, max: 255 },
    ],
    normalize: true,
    interpolate: false,
  });
};

// Helper to create GeoTIFF source for forest
const createForestSource = (year: string, version: MapModelVersion) => {
  return new GeoTIFF({
    sources: [
      { url: getForestCOGUrl(year, version), bands: [1], min: 0, max: 255 },
    ],
    normalize: true,
    interpolate: false,
  });
};

// Source caches - keyed by `${version}-${year}` to persist across renders
const deadwoodSourceCache: Record<string, GeoTIFF> = {};
const forestSourceCache: Record<string, GeoTIFF> = {};

// Get or create cached deadwood source
const getCachedDeadwoodSource = (
  year: string,
  version: MapModelVersion,
): GeoTIFF => {
  const key = `${version}-${year}`;
  if (!deadwoodSourceCache[key]) {
    console.debug(
      `[Cache] Creating new deadwood source for ${version}/${year}`,
    );
    deadwoodSourceCache[key] = createDeadwoodSource(year, version);
  } else {
    console.debug(
      `[Cache] Reusing cached deadwood source for ${version}/${year}`,
    );
  }
  return deadwoodSourceCache[key];
};

// Get or create cached forest source
const getCachedForestSource = (
  year: string,
  version: MapModelVersion,
): GeoTIFF => {
  const key = `${version}-${year}`;
  if (!forestSourceCache[key]) {
    console.debug(`[Cache] Creating new forest source for ${version}/${year}`);
    forestSourceCache[key] = createForestSource(year, version);
  } else {
    console.debug(
      `[Cache] Reusing cached forest source for ${version}/${year}`,
    );
  }
  return forestSourceCache[key];
};

const DeadtreesMap = () => {
  const [map, setMap] = useState<Map | null>(null);
  const [selectedYear, setSelectedYear] = useState<string>("2025");
  const [modelVersion, setModelVersion] = useState<MapModelVersion>("v2");
  const [bounds, setBounds] = useState<number[]>([]);
  const [sliderValue, setSliderValue] = useState<number>(1);
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const libertyBasemapLayerRef = useRef<LayerGroup | null>(null);
  const waybackBasemapLayerRef = useRef<TileLayer<XYZ> | null>(null);
  const forestLayerRef = useRef<TileLayerWebGL | null>(null);
  const deadwoodLayerRef = useRef<TileLayerWebGL | null>(null);
  const hasAutoSelectedImageryRef = useRef(false); // Track if we've done initial auto-selection
  const {
    DeadwoodMapViewport,
    setDeadwoodMapViewport,
    DeadwoodMapStyle,
    setDeadwoodMapStyle,
  } = useDatasetMap();

  // Flag feature state
  const [isDrawingFlag, setIsDrawingFlag] = useState(false);
  const [flagModalOpen, setFlagModalOpen] = useState(false);
  const [pendingFlagBbox, setPendingFlagBbox] = useState<
    [number, number, number, number] | null
  >(null);
  const [flagDescription, setFlagDescription] = useState("");
  const [showFlagsLayer, setShowFlagsLayer] = useState(true);
  const [currentZoom, setCurrentZoom] = useState<number>(
    DeadwoodMapViewport.zoom || 10,
  );
  const [flagCanFinish, setFlagCanFinish] = useState(false);
  const flagsLayerRef = useRef<VectorLayer<
    VectorSource<Feature<Polygon>>
  > | null>(null);
  const drawInteractionRef = useRef<Draw | null>(null);
  const flagDrawModeRef = useRef<FlagDrawMode | null>(null);
  const flagHoverOverlayRef = useRef<Overlay | null>(null);
  const clickedCellLayerRef = useRef<VectorLayer<
    VectorSource<Feature<Polygon>>
  > | null>(null);
  const clickedCellTooltipRef = useRef<Overlay | null>(null);
  const publicTreeObservationLayerRef = useRef<ReturnType<
    typeof createPublicTreeObservationLayer
  > | null>(null);
  const [publicObservationForm] =
    Form.useForm<PublicTreeObservationFormValues>();
  const [mobileMapPanel, setMobileMapPanel] =
    useState<MobileMapPanel | null>(null);
  const [showPublicContributions, setShowPublicContributions] = useState(true);
  const [isPlacingPublicObservation, setIsPlacingPublicObservation] =
    useState(false);
  const [publicObservationCoordinate, setPublicObservationCoordinate] =
    useState<{ lat: number; lon: number } | null>(null);
  const [publicObservationDrawerOpen, setPublicObservationDrawerOpen] =
    useState(false);

  // Layer visibility state - both layers visible by default
  const [showForest, setShowForest] = useState(true);
  const [showDeadwood, setShowDeadwood] = useState(true);
  const [deadwoodWarningModalOpen, setDeadwoodWarningModalOpen] =
    useState(false);

  // Auth privilege — needed before polygonAnalysis so effectiveModelVersion is available
  const { canAudit } = useCanAudit();
  // Non-auditors are locked to v1; auditors can freely switch
  const effectiveModelVersion: MapModelVersion = canAudit ? modelVersion : "v1";

  // Polygon analysis (drawing + stats)
  const polygonAnalysis = usePolygonAnalysis(mapRef, effectiveModelVersion);
  const userLocation = useUserLocationLayer(mapRef);
  const isMobile = useIsMobile();
  const {
    observations: publicTreeObservations,
    createObservation: createPublicTreeObservation,
  } = usePublicTreeObservations();

  // Wayback imagery state - using debounced location-based query
  // Default to a recent Wayback release (31144 = 2024) for immediate satellite display
  // This gets updated when location-specific wayback items load
  const DEFAULT_WAYBACK_RELEASE = 31144;
  const [selectedReleaseNum, setSelectedReleaseNum] = useState<number | null>(
    DEFAULT_WAYBACK_RELEASE,
  );
  const [autoMatchImagery, setAutoMatchImagery] = useState(true); // Auto-match imagery to prediction year

  // Track map center in lon/lat for location-specific wayback queries
  const [mapCenterLonLat, setMapCenterLonLat] = useState<{
    lon: number;
    lat: number;
  } | null>(() => {
    // Convert initial center from EPSG:3857 to EPSG:4326
    if (DeadwoodMapViewport.center) {
      const [lon, lat] = toLonLat(DeadwoodMapViewport.center);
      return { lon, lat };
    }
    return null;
  });

  // Fetch wayback items with actual imagery changes at current location (fast, no metadata)
  // Uses debouncing: only re-fetches when user moves > 2km or zoom changes > 3 levels
  const { data: localWaybackItems = [], isLoading: isWaybackLoading } =
    useWaybackItemsDebounced(
      mapCenterLonLat?.lon,
      mapCenterLonLat?.lat,
      currentZoom,
      DeadwoodMapStyle === "wayback", // Only fetch when wayback basemap is active
    );

  useMobileImageryAutoSelect({
    enabled: isMobile && DeadwoodMapStyle === "wayback",
    waybackItems: localWaybackItems,
    selectedReleaseNum,
    onImageryChange: setSelectedReleaseNum,
    autoMatchImagery,
    predictionYear: selectedYear,
  });

  // Clicked location values (displayed in legend)
  const [clickedValues, setClickedValues] = useState<ClickedValues | null>(
    null,
  );

  // Auth and flags hooks
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: mapFlags = [] } = useMapFlags();
  const createFlagMutation = useCreateMapFlag();

  // Handler for anonymous users clicking flag button
  const handleLoginRequired = useCallback(() => {
    // Pass current path as returnTo so user comes back to map after sign-in
    navigate("/sign-in?returnTo=/deadtrees");
  }, [navigate]);

  // handler functions
  const handleClick = useCallback(
    async (
      event: { coordinate: number[] },
      year: string,
      skipIfDrawing: boolean,
    ) => {
      // Skip click handling when drawing flag bbox
      if (skipIfDrawing) return;
      if (mapRef.current) {
        // Fetch both deadwood and forest values (forest also gives us the cell bounds)
        const [deadwoodResult, forestResult] = await Promise.all([
          getPixelValueOfCoordinate({
            coordinates: event.coordinate,
            cogUrl: getDeadwoodCOGUrl(year, effectiveModelVersion),
          }),
          getPixelValueOfCoordinate({
            coordinates: event.coordinate,
            cogUrl: getForestCOGUrl(year, effectiveModelVersion),
          }),
        ]);

        // Use cell bounds from forest raster to create the polygon
        const [minX, minY, maxX, maxY] = forestResult.cellBounds;
        const cellPolygon = new Polygon([
          [
            [minX, minY],
            [maxX, minY],
            [maxX, maxY],
            [minX, maxY],
            [minX, minY],
          ],
        ]);

        // Update clicked cell layer
        if (clickedCellLayerRef.current) {
          const source = clickedCellLayerRef.current.getSource();
          if (source) {
            source.clear();
            const feature = new Feature({ geometry: cellPolygon });
            source.addFeature(feature);
          }
        }

        const dwVal = Number(deadwoodResult.value) || 0;
        const fVal = Number(forestResult.value) || 0;
        // Normalize from 0-255 to 0-100%
        const deadwoodPct = dwVal > 0 ? Math.round((dwVal / 255) * 100) : 0;
        const forestPct = fVal > 0 ? Math.round((fVal / 255) * 100) : 0;

        // Update tooltip over the clicked cell - show active layers
        if (clickedCellTooltipRef.current) {
          const tooltipElement = clickedCellTooltipRef.current.getElement();
          if (tooltipElement) {
            // Build tooltip content based on which layers are active
            const layerParts: string[] = [];
            if (showForest) {
              layerParts.push(`<span style="display: flex; align-items: center; gap: 4px;">
                <span style="width: 8px; height: 8px; border-radius: 2px; background: ${mapColors.forest.fill};"></span>
                <span style="color: ${palette.neutral[700]};">Tree cover [%]</span>
                <span style="font-weight: 600;">${forestPct}%</span>
              </span>`);
            }
            if (showDeadwood) {
              layerParts.push(`<span style="display: flex; align-items: center; gap: 4px;">
                <span style="width: 8px; height: 8px; border-radius: 2px; background: ${mapColors.deadwood.fill};"></span>
                <span style="color: ${palette.neutral[700]};">Deadwood cover [%]</span>
                <span style="font-weight: 600;">${deadwoodPct}%</span>
              </span>`);
            }

            tooltipElement.innerHTML = `
            <div style="display: flex; align-items: center; gap: 12px; color: ${palette.neutral[800]};">
              ${layerParts.join("")}
              <button id="close-cell-tooltip" style="background: none; border: none; cursor: pointer; color: ${palette.neutral[500]}; font-size: 16px; line-height: 1; padding: 0 0 0 4px;">&times;</button>
            </div>
          `;
            // Add close button handler
            const closeBtn = tooltipElement.querySelector(
              "#close-cell-tooltip",
            );
            if (closeBtn) {
              closeBtn.addEventListener("click", () => {
                clickedCellTooltipRef.current?.setPosition(undefined);
                // Also clear the clicked cell layer
                if (clickedCellLayerRef.current) {
                  const source = clickedCellLayerRef.current.getSource();
                  if (source) source.clear();
                }
                setClickedValues(null);
              });
            }
          }
          // Position tooltip at top center of the cell
          const centerX = (minX + maxX) / 2;
          clickedCellTooltipRef.current.setPosition([centerX, maxY]);
        }

        // Update state to display in legend panel
        setClickedValues({ forestPct, deadwoodPct });
      }
    },
    [showDeadwood, showForest, effectiveModelVersion],
  );

  useEffect(() => {
    // console.log(DeadwoodMapViewport);
    if (!map) {
      const initialView = new View({
        // transform to EPSG:3857
        center: DeadwoodMapViewport.center,
        zoom: DeadwoodMapViewport.zoom,
      });
      const libertyBasemapLayer = createOpenFreeMapLibertyLayerGroup();
      libertyBasemapLayer.setVisible(DeadwoodMapStyle === "streets-v12");

      // Initialize with Wayback satellite imagery directly (using default release)
      const waybackBasemapLayer = createWaybackTileLayer(
        DEFAULT_WAYBACK_RELEASE,
      );
      waybackBasemapLayer.setVisible(DeadwoodMapStyle === "wayback");
      libertyBasemapLayerRef.current = libertyBasemapLayer;
      waybackBasemapLayerRef.current = waybackBasemapLayer;
      // Create only 2 layers - one for forest, one for deadwood (for current year)
      // Forest layer: Light green → Dark green gradient based on cover intensity
      const forestLayer = new TileLayerWebGL({
        source: getCachedForestSource(selectedYear, effectiveModelVersion),
        className: "forest-layer",
        style: {
          color: [
            "interpolate",
            ["linear"],
            ["band", 1],
            0,
            [144, 238, 144, 0], // Transparent
            0.1,
            [144, 238, 144, 0.7], // Light green, semi-transparent
            0.25,
            [124, 205, 124, 0.85], // Pale green
            0.4,
            [86, 180, 86, 0.9], // Medium light green
            0.55,
            [60, 150, 60, 0.95], // Medium green
            0.7,
            [34, 120, 34, 1], // Forest green
            0.85,
            [20, 90, 20, 1], // Dark green
            1,
            [0, 70, 0, 1], // Very dark green
          ],
        },
      });

      // Deadwood layer: selective yellow spectrum with enhanced visibility for high values
      // Low values are more transparent, high values are more visible
      const deadwoodLayer = new TileLayerWebGL({
        source: getCachedDeadwoodSource(selectedYear, effectiveModelVersion),
        className: "deadwood-layer",
        visible: true, // Both layers visible by default
        style: {
          color: [
            "interpolate",
            ["linear"],
            ["band", 1],
            0,
            [255, 220, 150, 0], // Fully transparent
            0.1,
            [255, 220, 150, 0], // Still fully transparent (filter noise)
            0.2,
            [255, 200, 100, 0.1], // Very low opacity for low values
            0.3,
            [255, 190, 70, 0.15], // Low opacity
            0.4,
            [255, 179, 50, 0.25], // Still low opacity
            0.5,
            [255, 179, 28, 0.4], // Medium-low opacity - Selective Yellow
            0.6,
            [240, 160, 25, 0.6], // Medium opacity - starts becoming visible
            0.7,
            [220, 145, 22, 0.8], // High opacity - clearly visible
            0.8,
            [204, 130, 20, 0.95], // Very high opacity
            0.9,
            [180, 115, 18, 1], // Fully opaque
            1,
            [40, 10, 60, 1], // Maximum visibility - fully opaque
          ],
        },
      });

      // Store refs
      forestLayerRef.current = forestLayer;
      deadwoodLayerRef.current = deadwoodLayer;

      // Create clicked cell layer for showing selected pixel
      const clickedCellSource = new VectorSource<Feature<Polygon>>();
      const clickedCellLayer = new VectorLayer({
        source: clickedCellSource,
        style: new Style({
          fill: new Fill({ color: mapColors.aoi.fill }),
          stroke: new Stroke({ color: mapColors.aoi.stroke, width: 2 }),
        }),
        zIndex: 50,
      });
      clickedCellLayerRef.current = clickedCellLayer;

      const publicTreeObservationLayer = createPublicTreeObservationLayer();
      publicTreeObservationLayerRef.current = publicTreeObservationLayer;

      const newMap = new Map({
        target: mapContainer.current || undefined,
        // Layer order: basemap -> model rasters -> overlays -> user location
        layers: [
          libertyBasemapLayer,
          waybackBasemapLayer,
          forestLayer,
          deadwoodLayer,
          clickedCellLayer,
          publicTreeObservationLayer,
          userLocation.layer,
        ],
        view: initialView,
        overlays: [],
        interactions: defaultInteractions({
          doubleClickZoom: false,
          pinchRotate: !isMobile,
          altShiftDragRotate: !isMobile,
        }),
        controls: createStandardMapControls({ includeAttribution: true }),
      });

      // Create flag hover overlay
      const flagPopupElement = document.createElement("div");
      flagPopupElement.id = "flag-popup";
      flagPopupElement.className = "ol-popup";
      flagPopupElement.style.cssText =
        "background: white; padding: 8px 12px; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); font-size: 12px; max-width: 250px; pointer-events: none;";

      const flagHoverOverlay = new Overlay({
        element: flagPopupElement,
        positioning: "bottom-center",
        offset: [0, -10],
      });
      newMap.addOverlay(flagHoverOverlay);
      flagHoverOverlayRef.current = flagHoverOverlay;

      // Create clicked cell tooltip overlay
      const cellTooltipElement = document.createElement("div");
      cellTooltipElement.id = "cell-tooltip";
      cellTooltipElement.style.cssText =
        "background: white; padding: 6px 10px; border-radius: 6px; box-shadow: 0 2px 6px rgba(0,0,0,0.15); font-size: 12px; white-space: nowrap; font-family: system-ui, sans-serif;";

      const cellTooltipOverlay = new Overlay({
        element: cellTooltipElement,
        positioning: "bottom-center",
        offset: [0, -8],
      });
      newMap.addOverlay(cellTooltipOverlay);
      clickedCellTooltipRef.current = cellTooltipOverlay;

      newMap.on("moveend", () => {
        const view = newMap.getView();
        const zoom = view.getZoom();
        const center = view.getCenter();
        if (center && typeof zoom === "number") {
          setDeadwoodMapViewport({
            center,
            zoom,
          });
        }
        setCurrentZoom(zoom || 10);

        // Update lon/lat center for wayback queries
        if (center) {
          const [lon, lat] = toLonLat(center);
          setMapCenterLonLat({ lon, lat });
        }
      });

      mapRef.current = newMap;
      // if (DeadwoodMapViewport.zoom != 2) {
      // newMap.getView().fit(transformExtent(bounds, "EPSG:4326", "EPSG:3857"));
      // }
      setMap(newMap);
    }

    return () => {
      userLocation.stop();
      const currentMap = mapRef.current;

      if (publicTreeObservationLayerRef.current) {
        currentMap?.removeLayer(publicTreeObservationLayerRef.current);
        publicTreeObservationLayerRef.current.getSource()?.clear();
        publicTreeObservationLayerRef.current.setSource(null);
        publicTreeObservationLayerRef.current = null;
      }

      if (clickedCellLayerRef.current) {
        currentMap?.removeLayer(clickedCellLayerRef.current);
        clickedCellLayerRef.current.getSource()?.clear();
        clickedCellLayerRef.current.setSource(null);
        clickedCellLayerRef.current = null;
      }

      mapRef.current?.setTarget(undefined);
      mapRef.current = null;
    };
    // OpenLayers map initialization is mounted once; map state changes are applied by focused effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // effects -----------------------------------------------------------

  // update on bounds change after geocoder search
  useEffect(() => {
    if (map && bounds.length > 0) {
      map.getView().fit(transformExtent(bounds, "EPSG:4326", "EPSG:3857"));
    }
  }, [bounds, map]);

  useEffect(() => {
    if (!map || !isMobile) return;
    map.getView().setRotation(0);
  }, [isMobile, map]);

  // update on mapStyle change
  useEffect(() => {
    const nextIsWayback = DeadwoodMapStyle === "wayback";
    libertyBasemapLayerRef.current?.setVisible(
      DeadwoodMapStyle === "streets-v12",
    );
    waybackBasemapLayerRef.current?.setVisible(nextIsWayback);

    if (selectedReleaseNum && waybackBasemapLayerRef.current) {
      waybackBasemapLayerRef.current.setSource(
        createWaybackSource(selectedReleaseNum),
      );
    }
  }, [DeadwoodMapStyle, map, selectedReleaseNum]);

  //update opacity of geotiff layers
  useEffect(() => {
    if (forestLayerRef.current) {
      forestLayerRef.current.setOpacity(sliderValue);
    }
    if (deadwoodLayerRef.current) {
      deadwoodLayerRef.current.setOpacity(sliderValue);
    }
  }, [sliderValue]);

  // update onClick handler when selectedYear changes
  useEffect(() => {
    if (mapRef.current) {
      // Add a new click listener with the current selectedYear
      const clickHandler = (event: { coordinate: number[] }) =>
        handleClick(
          event,
          selectedYear,
          isDrawingFlag ||
            polygonAnalysis.isDrawing ||
            isPlacingPublicObservation,
        );
      mapRef.current.on("click", clickHandler);

      // Clean up function to remove the listener
      return () => {
        if (mapRef.current) {
          mapRef.current.un("click", clickHandler);
        }
      };
    }
  }, [
    selectedYear,
    effectiveModelVersion,
    isDrawingFlag,
    polygonAnalysis.isDrawing,
    isPlacingPublicObservation,
    handleClick,
  ]);

  // Update sources when year or model version changes (use cached sources for instant switching)
  useEffect(() => {
    if (forestLayerRef.current && deadwoodLayerRef.current) {
      // Use cached sources - instant if already loaded
      forestLayerRef.current.setSource(
        getCachedForestSource(selectedYear, effectiveModelVersion),
      );
      deadwoodLayerRef.current.setSource(
        getCachedDeadwoodSource(selectedYear, effectiveModelVersion),
      );
      // Maintain visibility state after source update
      forestLayerRef.current.setVisible(showForest);
      deadwoodLayerRef.current.setVisible(showDeadwood);
    }
  }, [selectedYear, effectiveModelVersion, showForest, showDeadwood]);

  // Mark the first local imagery result as handled. The selected release is
  // initialized above; do not force the basemap back on if the user toggled it off.
  useEffect(() => {
    if (localWaybackItems.length > 0 && !hasAutoSelectedImageryRef.current) {
      hasAutoSelectedImageryRef.current = true;
    }
  }, [localWaybackItems.length]); // Only depend on length to run once when data loads

  // Switch from point marker to bbox polygon once the bbox is at least this many pixels wide
  const MIN_BBOX_PIXELS = 20;

  // Style function for flags - shows point marker when bbox is too small to see, bbox otherwise
  const getFlagStyle = useCallback(
    (feature: FeatureLike, resolution: number) => {
      const geometry = feature.getGeometry();
      const extent = geometry?.getExtent();
      const centerPoint = extent ? new Point(getCenter(extent)) : undefined;
      const bboxWidthPx = extent ? (extent[2] - extent[0]) / resolution : 0;
      const showAsPoint = bboxWidthPx < MIN_BBOX_PIXELS;

      if (showAsPoint) {
        return new Style({
          geometry: centerPoint,
          image: new CircleStyle({
            radius: 8,
            fill: new Fill({ color: mapColors.flag.fill }),
            stroke: new Stroke({ color: palette.neutral[0], width: 2 }),
          }),
        });
      } else {
        return new Style({
          fill: new Fill({ color: "rgba(22, 119, 255, 0.15)" }),
          stroke: new Stroke({ color: mapColors.flag.stroke, width: 2 }),
        });
      }
    },
    [],
  );

  // Create and update flags layer
  useEffect(() => {
    if (!mapRef.current || !user) return;

    // Create flags layer if it doesn't exist
    if (!flagsLayerRef.current) {
      const flagsSource = new VectorSource<Feature<Polygon>>();
      const flagsLayer = new VectorLayer({
        source: flagsSource,
        style: getFlagStyle,
        zIndex: 100,
      });
      flagsLayerRef.current = flagsLayer;
      mapRef.current.addLayer(flagsLayer);

      // Add hover handler for flags
      mapRef.current.on(
        "pointermove",
        (evt: { pixel: number[]; coordinate: number[] }) => {
          if (!flagHoverOverlayRef.current || !flagsLayerRef.current) return;

          const pixel = evt.pixel;
          const feature = mapRef.current?.forEachFeatureAtPixel(
            pixel,
            (f: FeatureLike, layer: unknown) => {
              if (layer === flagsLayerRef.current) return f;
              return undefined;
            },
          );

          if (feature) {
            const flagId = feature.get("flagId");
            const description = feature.get("description");
            const year = feature.get("year");
            const popupElement = flagHoverOverlayRef.current.getElement();
            if (popupElement) {
              popupElement.innerHTML = `
              <div style="font-family: system-ui, sans-serif;">
                <div style="font-weight: 600; color: ${mapColors.flag.stroke}; margin-bottom: 4px;">Flag #${flagId}${year ? ` · ${year}` : ""}</div>
                <div style="color: ${palette.neutral[800]}; line-height: 1.4;">${description}</div>
              </div>
            `;
            }
            flagHoverOverlayRef.current.setPosition(evt.coordinate);
          } else {
            flagHoverOverlayRef.current.setPosition(undefined);
          }
        },
      );
    } else {
      flagsLayerRef.current.setStyle(getFlagStyle);
    }

    // Update flags on the layer
    const source = flagsLayerRef.current.getSource();
    if (source) {
      source.clear();
      const visibleFlags = mapFlags.filter(
        (f) => !f.model_version || f.model_version === effectiveModelVersion,
      );
      visibleFlags.forEach((flag: IMapFlag) => {
        const [minLon, minLat, maxLon, maxLat] = flag.bbox;
        // Create polygon from bbox in EPSG:3857
        const extent = transformExtent(
          [minLon, minLat, maxLon, maxLat],
          "EPSG:4326",
          "EPSG:3857",
        );
        const polygon = new Polygon([
          [
            [extent[0], extent[1]],
            [extent[2], extent[1]],
            [extent[2], extent[3]],
            [extent[0], extent[3]],
            [extent[0], extent[1]],
          ],
        ]);
        const feature = new Feature({ geometry: polygon });
        feature.set("flagId", flag.id);
        feature.set("description", flag.description);
        feature.set("year", flag.year ?? null);
        // Store center for point rendering
        const centerX = (extent[0] + extent[2]) / 2;
        const centerY = (extent[1] + extent[3]) / 2;
        feature.set("center", [centerX, centerY]);
        source.addFeature(feature);
      });
    }
  }, [mapFlags, user, getFlagStyle, effectiveModelVersion]);

  // Toggle flags layer visibility
  useEffect(() => {
    if (flagsLayerRef.current) {
      flagsLayerRef.current.setVisible(showFlagsLayer);
    }
  }, [showFlagsLayer]);

  // Toggle forest layer visibility
  useEffect(() => {
    if (forestLayerRef.current) {
      forestLayerRef.current.setVisible(showForest);
    }
  }, [showForest]);

  // Toggle deadwood layer visibility
  useEffect(() => {
    if (deadwoodLayerRef.current) {
      deadwoodLayerRef.current.setVisible(showDeadwood);
    }
  }, [showDeadwood]);

  useEffect(() => {
    if (!publicTreeObservationLayerRef.current) return;
    syncPublicTreeObservationLayer(
      publicTreeObservationLayerRef.current,
      publicTreeObservations,
    );
  }, [publicTreeObservations]);

  useEffect(() => {
    publicTreeObservationLayerRef.current?.setVisible(showPublicContributions);
  }, [showPublicContributions]);

  // Show preview warning modal on initial load (once per browser session)
  useEffect(() => {
    const hasSeenWarning = sessionStorage.getItem(PREVIEW_WARNING_STORAGE_KEY);
    if (!hasSeenWarning) {
      setDeadwoodWarningModalOpen(true);
    }
  }, []);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(PREVIEW_WARNING_EVENT, {
        detail: { open: deadwoodWarningModalOpen },
      }),
    );

    return () => {
      window.dispatchEvent(
        new CustomEvent(PREVIEW_WARNING_EVENT, {
          detail: { open: false },
        }),
      );
    };
  }, [deadwoodWarningModalOpen]);

  const openFlagModalForGeometry = useCallback((geometry: Polygon) => {
    const extent = geometry.getExtent();
    const [minLon, minLat, maxLon, maxLat] = transformExtent(
      extent,
      "EPSG:3857",
      "EPSG:4326",
    );
    setPendingFlagBbox([minLon, minLat, maxLon, maxLat]);
    setFlagModalOpen(true);
  }, []);

  const cleanupFlagDrawing = useCallback(
    (drawToRemove: Draw | null, defer = false) => {
      const cleanup = () => {
        const map = mapRef.current;
        if (map && drawToRemove) {
          map.removeInteraction(drawToRemove);
        }
        if (map) {
          const mapElement = map.getTargetElement();
          if (mapElement) {
            mapElement.style.cursor = "";
          }
        }
        drawInteractionRef.current = null;
        flagDrawModeRef.current = null;
        setIsDrawingFlag(false);
        setFlagCanFinish(false);
      };

      if (defer) {
        queueMicrotask(cleanup);
      } else {
        cleanup();
      }
    },
    [],
  );

  const startDesktopFlagDrawing = useCallback(() => {
    if (!mapRef.current || isDrawingFlag) return;

    const mapElement = mapRef.current.getTargetElement();
    if (mapElement) {
      mapElement.style.cursor = "crosshair";
    }

    const source = new VectorSource<Feature<Polygon>>();
    const draw = new Draw({
      source,
      type: "Circle",
      geometryFunction: createBox(),
      style: new Style({
        fill: new Fill({ color: mapColors.aoi.fill }),
        stroke: new Stroke({
          color: mapColors.flag.stroke,
          width: 2,
          lineDash: [5, 5],
        }),
      }),
    });

    flagDrawModeRef.current = "bbox";
    draw.on("drawend", (event) => {
      openFlagModalForGeometry(event.feature.getGeometry() as Polygon);
      const drawToRemove = drawInteractionRef.current;
      cleanupFlagDrawing(drawToRemove, true);
    });

    mapRef.current.addInteraction(draw);
    drawInteractionRef.current = draw;
    setIsDrawingFlag(true);
    setFlagCanFinish(false);
    message.info("Click and drag to draw a rectangle on the map");
  }, [cleanupFlagDrawing, isDrawingFlag, openFlagModalForGeometry]);

  const startMobileFlagDrawing = useCallback(() => {
    if (!mapRef.current || isDrawingFlag) return;

    const mapElement = mapRef.current.getTargetElement();
    if (mapElement) {
      mapElement.style.cursor = "crosshair";
    }

    const source = new VectorSource<Feature<Polygon>>();
    const draw = new Draw({
      source,
      type: "Polygon",
      style: [
        new Style({
          fill: new Fill({ color: mapColors.aoi.fill }),
          stroke: new Stroke({
            color: mapColors.flag.stroke,
            width: 2,
            lineDash: [6, 4],
          }),
        }),
        new Style({
          image: new CircleStyle({
            radius: 5,
            fill: new Fill({ color: mapColors.flag.stroke }),
            stroke: new Stroke({ color: "#fff", width: 1.5 }),
          }),
        }),
      ],
    });

    flagDrawModeRef.current = "polygon";
    draw.on("drawstart", (event) => {
      const geometry = event.feature.getGeometry() as Polygon;
      setFlagCanFinish(false);

      geometry.on("change", () => {
        const coords = geometry.getCoordinates()[0];
        setFlagCanFinish(coords.length >= 4);
      });
    });

    draw.on("drawend", (event) => {
      openFlagModalForGeometry(event.feature.getGeometry() as Polygon);
      const drawToRemove = drawInteractionRef.current;
      cleanupFlagDrawing(drawToRemove, true);
    });

    mapRef.current.addInteraction(draw);
    drawInteractionRef.current = draw;
    setIsDrawingFlag(true);
    setFlagCanFinish(false);
    message.info(
      "Tap or click on the map to draw a polygon. Use Done to finish.",
    );
  }, [cleanupFlagDrawing, isDrawingFlag, openFlagModalForGeometry]);

  const startFlagDrawing = useCallback(() => {
    if (isMobile) {
      startMobileFlagDrawing();
    } else {
      startDesktopFlagDrawing();
    }
  }, [isMobile, startDesktopFlagDrawing, startMobileFlagDrawing]);

  // Cancel flag drawing
  const cancelFlagDrawing = useCallback(() => {
    const draw = drawInteractionRef.current;
    if (draw) {
      draw.abortDrawing();
    }
    cleanupFlagDrawing(draw);
  }, [cleanupFlagDrawing]);

  const undoFlagPoint = useCallback(() => {
    if (flagDrawModeRef.current !== "polygon") return;
    drawInteractionRef.current?.removeLastPoint();
  }, []);

  const finishFlagDrawing = useCallback(() => {
    if (flagDrawModeRef.current !== "polygon") return;
    if (!flagCanFinish) return;
    drawInteractionRef.current?.finishDrawing();
  }, [flagCanFinish]);

  // Submit flag
  const handleFlagSubmit = useCallback(async () => {
    if (!pendingFlagBbox || !flagDescription.trim()) {
      message.warning("Please enter a description for the flag");
      return;
    }

    try {
      await createFlagMutation.mutateAsync({
        bbox: pendingFlagBbox,
        description: flagDescription.trim(),
        year: selectedYear,
        model_version: effectiveModelVersion,
      });
      message.success("Flag added successfully");
      setFlagModalOpen(false);
      setPendingFlagBbox(null);
      setFlagDescription("");
    } catch (error) {
      message.error("Failed to add flag");
      console.error(error);
    }
  }, [
    pendingFlagBbox,
    flagDescription,
    selectedYear,
    effectiveModelVersion,
    createFlagMutation,
  ]);

  // Cancel flag modal
  const handleFlagCancel = useCallback(() => {
    setFlagModalOpen(false);
    setPendingFlagBbox(null);
    setFlagDescription("");
  }, []);

  // Handle preview warning modal close
  const handleDeadwoodWarningClose = useCallback(() => {
    setDeadwoodWarningModalOpen(false);
    sessionStorage.setItem(PREVIEW_WARNING_STORAGE_KEY, "true");
  }, []);

  // Handle map style change
  const handleMapStyleChange = useCallback(
    (style: string) => {
      setDeadwoodMapStyle((currentStyle) =>
        currentStyle === style ? "none" : style,
      );
    },
    [setDeadwoodMapStyle],
  );

  const handleAnalysisClick = useCallback(() => {
    if (isDrawingFlag) {
      cancelFlagDrawing();
    }
    if (polygonAnalysis.isDrawing) {
      polygonAnalysis.cancel();
    } else {
      polygonAnalysis.start();
    }
  }, [cancelFlagDrawing, isDrawingFlag, polygonAnalysis]);

  // Handle flag button click
  const handleFlagClick = useCallback(() => {
    if (polygonAnalysis.isDrawing) {
      polygonAnalysis.cancel();
    }
    if (isDrawingFlag) {
      cancelFlagDrawing();
    } else {
      startFlagDrawing();
    }
  }, [cancelFlagDrawing, isDrawingFlag, polygonAnalysis, startFlagDrawing]);

  const handleMobileAnalysisClick = useCallback(() => {
    setMobileMapPanel(null);
    handleAnalysisClick();
  }, [handleAnalysisClick]);

  const handleMobileFlagClick = useCallback(() => {
    setMobileMapPanel(null);
    handleFlagClick();
  }, [handleFlagClick]);

  const locateUser = userLocation.locateUser;

  useEffect(() => {
    if (!map || !isMobile) return;
    locateUser(false);
  }, [isMobile, map, locateUser]);

  useEffect(() => {
    if (userLocation.locationError) {
      message.warning(userLocation.locationError);
    }
  }, [userLocation.locationError]);

  const requestPublicObservationPlacement = useCallback(() => {
    if (!mapRef.current || !isMobile) return;

    if (polygonAnalysis.isDrawing) {
      polygonAnalysis.cancel();
    }
    if (isDrawingFlag) {
      cancelFlagDrawing();
    }

    locateUser(true);
    setMobileMapPanel(null);
    const coordinate = userLocation.currentCoordinate;
    if (coordinate) {
      mapRef.current.getView().animate({
        center: fromLonLat([coordinate.lon, coordinate.lat]),
        zoom: Math.max(mapRef.current.getView().getZoom() || 0, 18),
        duration: 500,
      });
    }

    setIsPlacingPublicObservation(true);
    message.info("Move the map so the crosshair is on the tree.");
  }, [
    cancelFlagDrawing,
    isDrawingFlag,
    isMobile,
    locateUser,
    polygonAnalysis,
    userLocation.currentCoordinate,
  ]);

  const cancelPublicObservationPlacement = useCallback(() => {
    setIsPlacingPublicObservation(false);
    setPublicObservationCoordinate(null);
    setPublicObservationDrawerOpen(false);
    publicObservationForm.resetFields();
  }, [publicObservationForm]);

  const acceptPublicObservationPlacement = useCallback(() => {
    const center = mapRef.current?.getView().getCenter();
    if (!center) return;

    const [lon, lat] = toLonLat(center);
    setPublicObservationCoordinate({ lon, lat });
    setIsPlacingPublicObservation(false);
    setPublicObservationDrawerOpen(true);
    publicObservationForm.setFieldsValue({
      condition: "dead",
      treeTypeGroup: "not_sure",
    });
  }, [publicObservationForm]);

  const handlePublicObservationSubmit = useCallback(async () => {
    if (!publicObservationCoordinate) return;

    try {
      const values = await publicObservationForm.validateFields();
      const payload: PublicTreeObservationInput = {
        lat: publicObservationCoordinate.lat,
        lon: publicObservationCoordinate.lon,
        condition: values.condition,
        treeTypeGroup: values.treeTypeGroup,
        treeTypeText: values.treeTypeText,
        comment: values.comment,
        clientId: getPublicTreeClientId(),
      };
      await createPublicTreeObservation.mutateAsync(payload);
      message.success("Observation added");
      setPublicObservationDrawerOpen(false);
      setPublicObservationCoordinate(null);
      publicObservationForm.resetFields();
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "errorFields" in error
      ) {
        return;
      }
      message.error("Could not add observation");
      console.error(error);
    }
  }, [
    createPublicTreeObservation,
    publicObservationCoordinate,
    publicObservationForm,
  ]);

  const handlePublicTreeObservationsDownload = useCallback(() => {
    if (publicTreeObservations.length === 0) {
      message.info("No point observations to download yet.");
      return;
    }

    downloadPublicTreeObservationsCsv(publicTreeObservations);
  }, [publicTreeObservations]);

  const activeMobileDrawMode = isMobile
    ? isDrawingFlag
      ? "flag"
      : polygonAnalysis.isDrawing
        ? "analysis"
        : isPlacingPublicObservation
          ? "public-observation"
          : null
    : null;
  const mobileCanFinish =
    activeMobileDrawMode === "analysis"
      ? polygonAnalysis.canFinish
      : activeMobileDrawMode === "flag"
        ? flagCanFinish
        : true;
  const hideMobileFloatingControls =
    !!activeMobileDrawMode || publicObservationDrawerOpen;
  const shouldHideYearImagerySelector =
    isDrawingFlag || polygonAnalysis.isDrawing || isPlacingPublicObservation;

  return (
    <div className="h-full w-full">
      <div
        style={{
          width: "100%",
          height: "100%",
          backgroundColor: "#ffffff",
        }}
        ref={mapContainer}
        data-testid="deadtrees-map"
      >
        {/* Top Left - Location Controls (desktop) */}
        <div className="absolute left-4 top-24 z-50 hidden md:block">
          <LocationControls
            onPlaceSelect={setBounds}
            variant="floating-card"
            onLocateMe={() => locateUser(true)}
            isLocating={userLocation.isLocating}
          />
        </div>

        {/* Top Right - Layer Controls (desktop) */}
        <div className="absolute right-4 top-24 z-50 hidden md:block">
          <LayerControlPanel
            mapStyle={DeadwoodMapStyle}
            onMapStyleChange={handleMapStyleChange}
            showForest={showForest}
            setShowForest={setShowForest}
            showDeadwood={showDeadwood}
            setShowDeadwood={setShowDeadwood}
            showPublicContributions={showPublicContributions}
            setShowPublicContributions={setShowPublicContributions}
            publicContributionsCount={publicTreeObservations.length}
            onDownloadPublicTreeObservations={
              handlePublicTreeObservationsDownload
            }
            opacity={sliderValue}
            setOpacity={setSliderValue}
            isDrawingPolygon={polygonAnalysis.isDrawing}
            onPolygonStatsClick={handleAnalysisClick}
            showFlagsControls={true}
            isLoggedIn={!!user}
            isDrawingFlag={isDrawingFlag}
            onFlagClick={handleFlagClick}
            onLoginRequired={handleLoginRequired}
            showFlagsLayer={showFlagsLayer}
            setShowFlagsLayer={setShowFlagsLayer}
            flagsCount={mapFlags.length}
            clickedValues={clickedValues}
            variant="floating-card"
            modelVersion={modelVersion}
            onModelVersionChange={canAudit ? setModelVersion : undefined}
          />
        </div>

        <MobileMapControls
          activePanel={mobileMapPanel}
          hidden={hideMobileFloatingControls}
          isAnalysisActive={polygonAnalysis.isDrawing}
          isLocating={userLocation.isLocating}
          isTracking={userLocation.isTracking}
          hasLocationFix={userLocation.hasFix}
          onLocate={() => locateUser(true)}
          onOpenPanel={(panel) =>
            setMobileMapPanel((currentPanel) =>
              currentPanel === panel ? null : panel,
            )
          }
        />

        <MobileTimePill
          year={selectedYear}
          active={mobileMapPanel === "time"}
          hidden={hideMobileFloatingControls}
          onClick={() =>
            setMobileMapPanel((currentPanel) =>
              currentPanel === "time" ? null : "time",
            )
          }
        />

        <MobileAddTreeButton
          hidden={hideMobileFloatingControls}
          onClick={requestPublicObservationPlacement}
        />

        {/* Top Center - Processing Stats */}
        {/* <div className="absolute left-1/2 top-24 z-50 -translate-x-1/2">
          <ProcessingStatsBanner />
        </div> */}

        {/* Bottom Center - Combined Year and Imagery Selector (desktop) */}
        {!isMobile && !shouldHideYearImagerySelector && (
          <div className="absolute bottom-2 left-1/2 z-50 w-[calc(100vw-1rem)] -translate-x-1/2 md:w-auto">
            <YearImagerySelector
              predictionYear={selectedYear}
              onPredictionYearChange={setSelectedYear}
              selectedReleaseNum={selectedReleaseNum}
              onImageryChange={setSelectedReleaseNum}
              waybackItems={localWaybackItems}
              isLoading={isWaybackLoading}
              isWaybackActive={DeadwoodMapStyle === "wayback"}
              autoMatchImagery={autoMatchImagery}
              onAutoMatchChange={setAutoMatchImagery}
              showForest={showForest}
              showDeadwood={showDeadwood}
              compactMode={isMobile}
            />
          </div>
        )}

        <MobileLayerDrawer
          open={mobileMapPanel === "layers" && !hideMobileFloatingControls}
          mapStyle={DeadwoodMapStyle}
          showForest={showForest}
          showDeadwood={showDeadwood}
          showPublicContributions={showPublicContributions}
          publicContributionsCount={publicTreeObservations.length}
          opacity={sliderValue}
          onClose={() => setMobileMapPanel(null)}
          onMapStyleChange={handleMapStyleChange}
          setShowForest={setShowForest}
          setShowDeadwood={setShowDeadwood}
          setShowPublicContributions={setShowPublicContributions}
          setOpacity={setSliderValue}
          onDownloadPublicTreeObservations={
            handlePublicTreeObservationsDownload
          }
        />

        <MobileTimeDrawer
          open={mobileMapPanel === "time" && !hideMobileFloatingControls}
          predictionYear={selectedYear}
          onPredictionYearChange={setSelectedYear}
          selectedReleaseNum={selectedReleaseNum}
          onImageryChange={setSelectedReleaseNum}
          waybackItems={localWaybackItems}
          isLoadingImagery={isWaybackLoading}
          isWaybackActive={DeadwoodMapStyle === "wayback"}
          autoMatchImagery={autoMatchImagery}
          onAutoMatchChange={setAutoMatchImagery}
          showForest={showForest}
          showDeadwood={showDeadwood}
          onClose={() => setMobileMapPanel(null)}
        />

        <MobileAnalysisDrawer
          open={mobileMapPanel === "analysis" && !hideMobileFloatingControls}
          isDrawingPolygon={polygonAnalysis.isDrawing}
          isDrawingFlag={isDrawingFlag}
          isLoggedIn={!!user}
          onClose={() => setMobileMapPanel(null)}
          onAnalyzeClick={handleMobileAnalysisClick}
          onFlagClick={handleMobileFlagClick}
          onLoginRequired={handleLoginRequired}
        />

        {activeMobileDrawMode && (
          <div
            className="pointer-events-none absolute left-1/2 z-[60] w-fit max-w-[calc(100vw-1.5rem)] -translate-x-1/2 md:hidden"
            style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
          >
            <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-gray-200/80 bg-white/95 p-2 shadow-xl backdrop-blur-sm">
              <div className="hidden min-w-0 flex-1 px-1 sm:block">
                <div className="text-xs font-semibold text-gray-700">
                  {activeMobileDrawMode === "analysis"
                    ? "Analyze Area"
                    : activeMobileDrawMode === "flag"
                      ? "Flag Area"
                      : "Place tree"}
                </div>
                <div className="text-[11px] text-gray-500">
                  {activeMobileDrawMode === "analysis"
                    ? "Tap the map to add points"
                    : activeMobileDrawMode === "flag"
                      ? "Tap the map to outline the flagged area"
                      : "Move the map under the crosshair"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="small"
                  icon={<CloseOutlined />}
                  onClick={
                    activeMobileDrawMode === "analysis"
                      ? polygonAnalysis.cancel
                      : activeMobileDrawMode === "flag"
                        ? cancelFlagDrawing
                        : cancelPublicObservationPlacement
                  }
                >
                  Cancel
                </Button>
                {activeMobileDrawMode !== "public-observation" && (
                  <Button
                    size="small"
                    icon={<UndoOutlined />}
                    onClick={
                      activeMobileDrawMode === "analysis"
                        ? polygonAnalysis.undoLastPoint
                        : undoFlagPoint
                    }
                  >
                    Undo
                  </Button>
                )}
                <Button
                  size="small"
                  type="primary"
                  icon={<CheckOutlined />}
                  disabled={!mobileCanFinish}
                  onClick={
                    activeMobileDrawMode === "analysis"
                      ? polygonAnalysis.finish
                      : activeMobileDrawMode === "flag"
                        ? finishFlagDrawing
                        : acceptPublicObservationPlacement
                  }
                >
                  {activeMobileDrawMode === "public-observation"
                    ? "Continue"
                    : "Done"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {isPlacingPublicObservation && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 z-[55] -translate-x-1/2 -translate-y-1/2 md:hidden">
            <div className="relative h-12 w-12">
              <div className="absolute left-1/2 top-0 h-12 w-px -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(17,24,39,0.65)]" />
              <div className="absolute left-0 top-1/2 h-px w-12 -translate-y-1/2 bg-white shadow-[0_0_0_1px_rgba(17,24,39,0.65)]" />
              <div className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-red-700 shadow-[0_0_0_1px_rgba(17,24,39,0.65)]" />
            </div>
            {mapCenterLonLat && (
              <div className="absolute left-1/2 top-[calc(50%+2.1rem)] w-max -translate-x-1/2 rounded-full border border-slate-200/80 bg-white/95 px-3 py-1 text-[11px] font-semibold tabular-nums text-slate-700 shadow-lg backdrop-blur-sm">
                {mapCenterLonLat.lat.toFixed(6)},{" "}
                {mapCenterLonLat.lon.toFixed(6)}
              </div>
            )}
          </div>
        )}

        <Drawer
          title="Tree observation"
          placement="bottom"
          height="auto"
          open={publicObservationDrawerOpen}
          onClose={cancelPublicObservationPlacement}
          className="md:hidden"
          rootClassName="map-controls-mobile-drawer"
          styles={{
            header: { padding: "12px 16px" },
            body: { padding: 16, overflowX: "hidden" },
          }}
        >
          <Form
            form={publicObservationForm}
            layout="vertical"
            initialValues={{
              condition: "dead",
              treeTypeGroup: "not_sure",
            }}
          >
            <Form.Item
              label="Tree condition"
              name="condition"
              rules={[{ required: true, message: "Select a tree condition" }]}
            >
              <Select options={publicTreeConditionOptions} />
            </Form.Item>

            <Form.Item
              label="Tree type"
              name="treeTypeGroup"
              rules={[{ required: true, message: "Select a tree type" }]}
            >
              <Select options={publicTreeTypeGroupOptions} />
            </Form.Item>

            <Form.Item label="Specific species name" name="treeTypeText">
              <Input
                maxLength={80}
                placeholder="Optional, e.g. Norway spruce or European beech"
              />
            </Form.Item>

            <Form.Item label="Comment" name="comment">
              <Input.TextArea
                maxLength={200}
                rows={3}
                showCount
                placeholder="Optional short note"
              />
            </Form.Item>

            <div className="flex items-center gap-2">
              <Button block onClick={cancelPublicObservationPlacement}>
                Cancel
              </Button>
              <Button
                block
                type="primary"
                icon={<SendOutlined />}
                loading={createPublicTreeObservation.isPending}
                onClick={handlePublicObservationSubmit}
              >
                Add point
              </Button>
            </div>
          </Form>
        </Drawer>
      </div>

      {/* Flag description modal */}
      <Modal
        title="Flag this area"
        open={flagModalOpen}
        onOk={handleFlagSubmit}
        onCancel={handleFlagCancel}
        okText="Submit Flag"
        confirmLoading={createFlagMutation.isPending}
      >
        <div className="flex flex-col gap-4">
          <p className="text-gray-600">
            Describe what you noticed in this area (e.g., incorrect prediction,
            missing deadwood, etc.)
          </p>
          <Input.TextArea
            value={flagDescription}
            onChange={(e) => setFlagDescription(e.target.value)}
            placeholder="Enter your description..."
            rows={4}
            maxLength={500}
            showCount
          />
          <p className="text-xs text-gray-400">Year: {selectedYear}</p>
        </div>
      </Modal>

      {/* Deadwood warning modal */}
      <Modal
        title={
          <div className="flex items-center gap-2">
            <ExperimentOutlined className="text-orange-500" />
            <span>
              {isMobile ? "Preview Notice" : "Preview Visualization Notice"}
            </span>
          </div>
        }
        open={deadwoodWarningModalOpen}
        onOk={handleDeadwoodWarningClose}
        onCancel={handleDeadwoodWarningClose}
        okText="I Understand"
        cancelButtonProps={{ style: { display: "none" } }}
        okButtonProps={{ size: "middle" }}
        centered={!isMobile}
        width={isMobile ? "calc(100vw - 24px)" : 480}
        styles={{
          body: {
            maxHeight: isMobile ? "70vh" : undefined,
            overflowY: isMobile ? "auto" : undefined,
          },
        }}
      >
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex gap-2.5 rounded-lg bg-orange-50 p-3">
            <InfoCircleOutlined className="mt-0.5 text-lg text-orange-500" />
            <div className="text-gray-700">
              <p className="mb-1 font-medium text-orange-700">Alpha preview</p>
              <p className="text-sm leading-6">
                This map is still evolving. Use it to explore patterns, not to
                draw final conclusions.
              </p>
            </div>
          </div>

          <div className="flex gap-2.5 rounded-lg bg-blue-50 p-3">
            <FlagOutlined className="mt-0.5 text-lg text-blue-500" />
            <div className="text-gray-700">
              <p className="mb-1 font-medium text-blue-700">Share feedback</p>
              <p className="text-sm leading-6">
                After signing in, use{" "}
                <span className="font-semibold text-blue-600">Flag Area</span>{" "}
                to report issues in your forest or study area.
              </p>
            </div>
          </div>
        </div>
      </Modal>

      {/* Polygon stats modal */}
      <PolygonStatsModal
        open={polygonAnalysis.modalOpen}
        onClose={polygonAnalysis.closeModal}
        data={polygonAnalysis.stats.data}
        loading={polygonAnalysis.stats.loading}
        error={polygonAnalysis.stats.error}
      />
    </div>
  );
};

export default DeadtreesMap;

// view: geotiffSource.getView(),
// view: new View({
//   center: fromLonLat([10.668224826784524, 51.78688853393797]),
//   zoom: 15,
// }),

//   source: new TileJSON({
//     url: `https://api.maptiler.com/maps/satellite/tiles.json?key=${import.meta.env.VITE_MAPTILER_KEY}`,
//     crossOrigin: "anonymous",
//     tileSize: 512,
//   }),
