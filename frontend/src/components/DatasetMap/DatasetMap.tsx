import { useEffect, useRef, useCallback, useState } from "react";
import { Map, View } from "ol";
import type MapBrowserEvent from "ol/MapBrowserEvent";
import { defaults as defaultInteractions } from "ol/interaction";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import type { FeatureLike } from "ol/Feature";
import type { SelectEvent } from "ol/interaction/Select";
import "ol/ol.css";
import { fromExtent } from "ol/geom/Polygon.js";
import { useNavigate } from "react-router-dom";
import { IDataset } from "../../types/dataset";
import parseBBox from "../../utils/parseBBox";
import {
  applyOpenFreeMapLibertyStyle,
  createOpenStreetMapFallbackLayer,
  createStandardMapControls,
} from "../../utils/basemaps";
import Style from "ol/style/Style";
import Fill from "ol/style/Fill";
import Stroke from "ol/style/Stroke";
import Circle from "ol/style/Circle";
import Overlay from "ol/Overlay";
import Select from "ol/interaction/Select.js";
import { useDatasetMap } from "../../hooks/useDatasetMapProvider";
import "./tooltip.css";
import { useDatasetDetailsMap } from "../../hooks/useDatasetDetailsMapProvider";
import { palette } from "../../theme/palette";

export type DatasetMapColorMode = "quality" | "labels" | "year" | "timeline";

type DatasetVisualSpec = {
  fill: string;
  stroke: string;
  marker: string;
};

const withAlpha = (hex: string, alpha: number): string => {
  const cleanHex = hex.replace("#", "");
  const fullHex =
    cleanHex.length === 3
      ? cleanHex
        .split("")
        .map((char) => `${char}${char}`)
        .join("")
      : cleanHex;
  const r = parseInt(fullHex.substring(0, 2), 16);
  const g = parseInt(fullHex.substring(2, 4), 16);
  const b = parseInt(fullHex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const createExtentStyle = (spec: DatasetVisualSpec): Style =>
  new Style({
    fill: new Fill({ color: withAlpha(spec.fill, 0.32) }),
    stroke: new Stroke({ color: spec.stroke, width: 1.5 }),
  });

const createMarkerStyle = (spec: DatasetVisualSpec, hovered = false): Style =>
  new Style({
    image: new Circle({
      radius: hovered ? 8 : 5,
      fill: new Fill({ color: withAlpha(spec.marker, hovered ? 0.9 : 0.7) }),
      stroke: new Stroke({ color: "#ffffff", width: hovered ? 2.5 : 1.5 }),
    }),
  });

const createHoverExtentStyle = (spec: DatasetVisualSpec): Style =>
  new Style({
    fill: new Fill({ color: withAlpha(spec.fill, 0.52) }),
    stroke: new Stroke({ color: "#ffffff", width: 2.5 }),
  });

const parseYear = (dataset: IDataset): number | null => {
  const year = Number.parseInt(dataset.aquisition_year, 10);
  return Number.isNaN(year) ? null : year;
};

const getDatasetVisualSpec = (dataset: IDataset, mode: DatasetMapColorMode): DatasetVisualSpec => {
  if (mode === "labels") {
    if (dataset.has_labels) {
      return {
        fill: palette.primary[500],
        stroke: palette.primary[700],
        marker: palette.primary[600],
      };
    }
    if (dataset.has_deadwood_prediction) {
      return {
        fill: palette.secondary[500],
        stroke: palette.secondary[600],
        marker: palette.secondary[500],
      };
    }
    return {
      fill: palette.neutral[500],
      stroke: palette.neutral[700],
      marker: palette.neutral[700],
    };
  }

  if (mode === "year") {
    const year = parseYear(dataset);
    if (!year) {
      return {
        fill: palette.neutral[500],
        stroke: palette.neutral[700],
        marker: palette.neutral[700],
      };
    }
    if (year >= 2024) {
      return {
        fill: "#EC4899",
        stroke: "#BE185D",
        marker: "#BE185D",
      };
    }
    if (year >= 2021) {
      return {
        fill: "#58A67A",
        stroke: "#468564",
        marker: "#468564",
      };
    }
    if (year >= 2018) {
      return {
        fill: "#355F8D",
        stroke: "#2A4C71",
        marker: "#2A4C71",
      };
    }
    return {
      fill: "#2C1E7A",
      stroke: "#221760",
      marker: "#221760",
    };
  }

  if (mode === "timeline") {
    return {
      fill: palette.deadwood[500],
      stroke: palette.deadwood[700],
      marker: palette.deadwood[600],
    };
  }

  const finalAssessment = dataset.final_assessment;
  const hasBadQuality = dataset.deadwood_quality === "bad" || dataset.forest_cover_quality === "bad";
  const hasMediumQuality = dataset.deadwood_quality === "sentinel_ok" || dataset.forest_cover_quality === "sentinel_ok";

  if (finalAssessment === "exclude_completely" || hasBadQuality || dataset.has_major_issue) {
    return {
      fill: palette.state.error,
      stroke: "#B91C1C",
      marker: "#DC2626",
    };
  }
  if (finalAssessment === "fixable_issues" || hasMediumQuality) {
    return {
      fill: palette.deadwood[500],
      stroke: palette.deadwood[700],
      marker: palette.deadwood[700],
    };
  }
  if (finalAssessment === "no_issues" || finalAssessment === "ready" || dataset.is_audited) {
    return {
      fill: palette.forest[500],
      stroke: palette.forest[700],
      marker: palette.forest[600],
    };
  }
  return {
    fill: palette.neutral[500],
    stroke: palette.neutral[700],
    marker: palette.neutral[700],
  };
};

const formatAcquisitionDate = (dataset: IDataset): string => {
  const year = Number.parseInt(dataset.aquisition_year, 10);
  if (Number.isNaN(year)) return "Unknown date";

  const month = dataset.aquisition_month ? Number.parseInt(dataset.aquisition_month, 10) : 1;
  const day = dataset.aquisition_day ? Number.parseInt(dataset.aquisition_day, 10) : 1;

  return new Date(year, Math.max(month - 1, 0), Math.max(day, 1)).toLocaleDateString("en-US", {
    year: "numeric",
    month: dataset.aquisition_month ? "long" : undefined,
    day: dataset.aquisition_day ? "numeric" : undefined,
  });
};

const buildTooltipTitle = (dataset: IDataset): string => {
  const place = dataset.admin_level_3 || dataset.admin_level_2 || "";
  const country = dataset.admin_level_1 || "";

  if (place && country) return `${place}, ${country}`;
  if (place) return place;
  if (country) return country;
  return `Dataset #${dataset.id}`;
};

interface MapRef extends Map {
  moveEndListener?: () => void;
  pointerMoveListener?: (evt: MapBrowserEvent<UIEvent>) => void;
  selectOnClick?: Select;
  selectListener?: (e: SelectEvent) => void;
  tooltip?: Overlay;
}

const DatasetMapOL = ({
  data,
  hoveredItem,
  setHoveredItem,
  setVisibleFeatures,
  filterZoomTrigger = 0,
  colorMode = "quality",
}: {
  data: IDataset[];
  hoveredItem: number | null;
  setHoveredItem: (id: number | null) => void;
  setVisibleFeatures: (ids: string[]) => void;
  filterZoomTrigger?: number;
  colorMode?: DatasetMapColorMode;
}) => {
  const navigate = useNavigate();
  const mapRef = useRef<MapRef | null>(null);
  const vectorLayerExtendRef = useRef<VectorLayer<VectorSource> | null>(null);
  const vectorLayerMarkerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const mapContainer = useRef<HTMLDivElement>(null);
  const { DatasetViewport, setDatasetViewport } = useDatasetMap();
  // Track previous trigger value to only zoom on explicit filter actions
  const prevZoomTriggerRef = useRef(filterZoomTrigger);
  const [mapLayersReady, setMapLayersReady] = useState(false);
  const { setNavigationSource } = useDatasetDetailsMap();
  const setHoveredItemRef = useRef(setHoveredItem);
  const setVisibleFeaturesRef = useRef(setVisibleFeatures);
  const setNavigationSourceRef = useRef(setNavigationSource);
  const navigateRef = useRef(navigate);

  useEffect(() => {
    setHoveredItemRef.current = setHoveredItem;
    setVisibleFeaturesRef.current = setVisibleFeatures;
    setNavigationSourceRef.current = setNavigationSource;
    navigateRef.current = navigate;
  }, [setHoveredItem, setVisibleFeatures, setNavigationSource, navigate]);

  const updateVisibleFeatures = useCallback(() => {
    if (!mapRef.current || !vectorLayerExtendRef.current) return;

    const extent = mapRef.current.getView().calculateExtent(mapRef.current.getSize());
    const source = vectorLayerExtendRef.current.getSource();
    if (!source) return;

    const visibleFeatures = source.getFeaturesInExtent(extent);
    const visibleIds = visibleFeatures.map((feature) => String(feature.get("id")));

    // console.log(`Found ${visibleIds.length} visible features`);

    // Simply return the visible features even if empty array
    // No need to handle the empty case specially anymore
    setVisibleFeaturesRef.current(visibleIds);
  }, []);

  useEffect(() => {
    // console.log("initial map useEffect");
    if (!mapRef.current && mapContainer.current) {
      const initialView = new View({
        center: DatasetViewport.center,
        zoom: DatasetViewport.zoom,
      });

      const map = new Map({
        target: mapContainer.current,
        layers: [],
        controls: createStandardMapControls(),
        interactions: defaultInteractions({ doubleClickZoom: false }),
        view: initialView,
      });
      mapRef.current = map as MapRef;

      let disposed = false;

      void applyOpenFreeMapLibertyStyle(map)
        .then(() => {
          if (disposed) return;

          const streetsFallbackLayer = createOpenStreetMapFallbackLayer();
          map.addLayer(streetsFallbackLayer);

          const vectorSourceExtend = new VectorSource();
          const vectorLayerExtend = new VectorLayer({
            source: vectorSourceExtend,
            minZoom: 9,
            updateWhileAnimating: false,
            updateWhileInteracting: false,
          });
          vectorLayerExtendRef.current = vectorLayerExtend;
          map.addLayer(vectorLayerExtend);

          const vectorSourceMarker = new VectorSource();
          const vectorLayerMarker = new VectorLayer({
            source: vectorSourceMarker,
            maxZoom: 11,
            updateWhileAnimating: false,
            updateWhileInteracting: false,
          });
          vectorLayerMarkerRef.current = vectorLayerMarker;
          map.addLayer(vectorLayerMarker);
          setMapLayersReady(true);

          const element = document.createElement("div");
          element.className = "tooltip hidden";
          const tooltip = new Overlay({
            element,
            offset: [0, -50],
            positioning: "top-center",
          });
          map.addOverlay(tooltip);

          // Store listener references
          const moveEndListener = () => {
            const newViewport = {
              center: map.getView().getCenter() as number[],
              zoom: map.getView().getZoom() as number,
            };
            setDatasetViewport(newViewport);
            updateVisibleFeatures();
          };
          map.on("moveend", moveEndListener);

          mapRef.current!.moveEndListener = moveEndListener;
          mapRef.current!.tooltip = tooltip;

          const pointerMoveListener = (evt: MapBrowserEvent<UIEvent>) => {
            if (evt.dragging) return;
            const pixel = map.getEventPixel(evt.originalEvent);

            const hoveredFeature =
              map.forEachFeatureAtPixel<FeatureLike>(
                pixel,
                (feature) => feature,
                {
                  layerFilter: (layer) =>
                    layer === vectorLayerExtendRef.current || layer === vectorLayerMarkerRef.current,
                },
              ) ?? null;

            if (hoveredFeature) {
              const featureId = hoveredFeature.get("id");
              setHoveredItemRef.current(featureId);
              const targetElement = map.getTargetElement();
              if (targetElement) {
                targetElement.style.cursor = "pointer";
              }
              tooltip.setPosition(evt.coordinate);

              const tooltipContent = `
                <div class="tooltip-content">
                  <div>${hoveredFeature.get("title")} (${hoveredFeature.get("date")})</div>
                </div>
              `;

              const tooltipElement = tooltip.getElement();
              if (tooltipElement) {
                tooltipElement.innerHTML = tooltipContent;
                tooltipElement.classList.remove("hidden");
              }

              const hoverStyle = hoveredFeature.get("hoverStyle");
              if (hoverStyle) {
                hoveredFeature.setStyle(hoverStyle);
              }
            } else {
              setHoveredItemRef.current(null);
              const targetElement = map.getTargetElement();
              if (targetElement) {
                targetElement.style.cursor = "";
              }
              tooltip.getElement()?.classList.add("hidden");

              vectorLayerExtendRef.current
                ?.getSource()
                .getFeatures()
                .forEach((f) => f.setStyle(f.get("baseStyle")));
              vectorLayerMarkerRef.current
                ?.getSource()
                .getFeatures()
                .forEach((f) => f.setStyle(f.get("baseStyle")));
            }
          };
          map.on("pointermove", pointerMoveListener);
          mapRef.current!.pointerMoveListener = pointerMoveListener;

          const selectOnClick = new Select({
            condition: (event) => event.type === "pointerup",
            layers: [vectorLayerExtend, vectorLayerMarker],
          });

          map.addInteraction(selectOnClick);
          const selectListener = (e: SelectEvent) => {
            const selectedFeatures = e.selected;
            if (selectedFeatures.length > 0) {
              const feature = selectedFeatures[0];
              const id = feature.get("id");
              setNavigationSourceRef.current("dataset");
              navigateRef.current(`/dataset/${id}`);
            }
          };
          selectOnClick.on("select", selectListener);
          mapRef.current!.selectOnClick = selectOnClick;
          mapRef.current!.selectListener = selectListener;

          requestAnimationFrame(() => {
            map.updateSize();
          });
        })
        .catch((error) => {
          console.error("Failed to initialize OpenFreeMap Liberty on dataset map", error);
        });

      return () => {
        disposed = true;

        if (mapRef.current) {
          const map = mapRef.current;

          if (map.selectOnClick && map.selectListener) {
            map.selectOnClick.un("select", map.selectListener);
            map.selectOnClick.dispose();
          }

          if (map.tooltip) {
            map.removeOverlay(map.tooltip);
            map.tooltip.dispose();
          }

          vectorLayerExtendRef.current?.getSource().dispose();
          vectorLayerMarkerRef.current?.getSource().dispose();

          vectorLayerExtendRef.current?.dispose();
          vectorLayerMarkerRef.current?.dispose();

          if (map.moveEndListener) {
            map.un("moveend", map.moveEndListener);
          }
          if (map.pointerMoveListener) {
            map.un("pointermove", map.pointerMoveListener);
          }

          if (map.tooltip) {
            map.removeOverlay(map.tooltip);
          }

          map.getLayers().forEach((layer) => {
            const source = layer?.getSource?.();
            if (source && "dispose" in source) {
              source.dispose();
            }
            map.removeLayer(layer);
          });

          map.getControls().clear();
          map.getInteractions().clear();
          map.getOverlays().clear();
          map.setTarget(null);

          mapRef.current = null;
          vectorLayerExtendRef.current = null;
          vectorLayerMarkerRef.current = null;
          setMapLayersReady(false);
        } else {
          map.setTarget(null);
          map.dispose();
        }
      };
    }
  }, []);

  useEffect(() => {
    // console.log("updating data", data.length);
    if (mapLayersReady && vectorLayerExtendRef.current && vectorLayerMarkerRef.current && mapRef.current) {
      const vectorSourceExtend = vectorLayerExtendRef.current.getSource();
      const vectorSourceMarker = vectorLayerMarkerRef.current.getSource();

      vectorSourceExtend.clear();
      vectorSourceMarker.clear();

      data.forEach((dataset) => {
        if (dataset.bbox) {
          const parsedBBox = parseBBox(dataset.bbox);
          if (parsedBBox) {
            const visualSpec = getDatasetVisualSpec(dataset, colorMode);
            const extentStyle = createExtentStyle(visualSpec);
            const extentHoverStyle = createHoverExtentStyle(visualSpec);
            const markerStyle = createMarkerStyle(visualSpec);
            const markerHoverStyle = createMarkerStyle(visualSpec, true);
            const extentFeature = new Feature(fromExtent(parsedBBox).transform("EPSG:4326", "EPSG:3857"));
            extentFeature.setProperties({
              id: dataset.id,
              title: buildTooltipTitle(dataset),
              thumbnail_path: dataset.thumbnail_path,
              date: formatAcquisitionDate(dataset),
              baseStyle: extentStyle,
              hoverStyle: extentHoverStyle,
            });
            extentFeature.setStyle(extentStyle);
            vectorSourceExtend.addFeature(extentFeature);

            const point = extentFeature.getGeometry().getInteriorPoint();
            const pointFeature = new Feature(point);
            pointFeature.setProperties({
              id: dataset.id,
              title: buildTooltipTitle(dataset),
              date: formatAcquisitionDate(dataset),
              baseStyle: markerStyle,
              hoverStyle: markerHoverStyle,
            });
            pointFeature.setStyle(markerStyle);
            vectorSourceMarker.addFeature(pointFeature);
          }
        }
      });
      // Only zoom when triggered by an explicit filter action (counter changed)
      if (filterZoomTrigger !== prevZoomTriggerRef.current) {
        prevZoomTriggerRef.current = filterZoomTrigger;
        if (vectorLayerExtendRef.current && mapRef.current) {
          const source = vectorLayerExtendRef.current.getSource();
          if (source.getFeatures().length > 0) {
            const extent = source.getExtent();
            mapRef.current.getView().fit(extent, {
              padding: [50, 50, 50, 50],
              maxZoom: 18,
            });
          }
        }
      }
    }
  }, [data, filterZoomTrigger, colorMode, mapLayersReady]);

  // Handle feature highlighting separately
  useEffect(() => {
    // console.log("hoveredItem changed", hoveredItem);
    if (vectorLayerExtendRef.current && vectorLayerMarkerRef.current) {
      const vectorSourceExtend = vectorLayerExtendRef.current.getSource();
      const vectorSourceMarker = vectorLayerMarkerRef.current.getSource();

      vectorSourceExtend.getFeatures().forEach((feature) => {
        const featureId = feature.get("id");
        feature.setStyle(featureId === hoveredItem ? feature.get("hoverStyle") : feature.get("baseStyle"));
      });

      vectorSourceMarker.getFeatures().forEach((feature) => {
        const featureId = feature.get("id");
        feature.setStyle(featureId === hoveredItem ? feature.get("hoverStyle") : feature.get("baseStyle"));
      });
    }
  }, [hoveredItem]);

  // Update visible features after data changes and map is rendered
  useEffect(() => {
    if (mapLayersReady && mapRef.current && vectorLayerExtendRef.current) {
      const source = vectorLayerExtendRef.current.getSource();
      if (source && source.getFeatures().length > 0) {
        // console.log(`Data updated, found ${source.getFeatures().length} features total`);
        // Update visible features immediately
        updateVisibleFeatures();
      } else {
        // If no features found, try again after a short delay to ensure rendering complete
        const timer = setTimeout(() => {
          // console.log("Trying to update visible features after delay");
          updateVisibleFeatures();
        }, 300);

        return () => clearTimeout(timer);
      }
    }
  }, [data, updateVisibleFeatures, mapLayersReady]);

  return <div ref={mapContainer} style={{ width: "100%", height: "100%", borderRadius: 8 }}></div>;
};

export default DatasetMapOL;
