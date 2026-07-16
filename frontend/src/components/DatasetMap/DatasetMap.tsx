import { useEffect, useRef, useCallback, useState, memo } from "react";
// Aliased so that `Map` keeps referring to the built-in Map in this module.
import { Map as OLMap, View } from "ol";
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
import { IDataAccess, IDataset, IDatasetArchiveItem } from "../../types/dataset";
import parseBBox from "../../utils/parseBBox";
import {
  acquireLibertyBasemapGroup,
  createStandardMapControls,
  releaseLibertyBasemapGroup,
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
import { transitionDatasetFeatureHover } from "./datasetFeatureHover";

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

interface DatasetStyleBundle {
  extent: Style;
  extentHover: Style;
  marker: Style;
  markerHover: Style;
}

// A dataset's styling depends only on its visual spec, of which there are a
// handful. Styles are immutable here (features only ever get one assigned), so
// they can be shared instead of allocating 4 per dataset — ~30k objects, and the
// GC churn that comes with them — on every map rebuild.
const styleBundleCache = new Map<string, DatasetStyleBundle>();

const getStyleBundle = (spec: DatasetVisualSpec): DatasetStyleBundle => {
  const key = `${spec.fill}|${spec.stroke}|${spec.marker}`;
  let bundle = styleBundleCache.get(key);
  if (!bundle) {
    bundle = {
      extent: createExtentStyle(spec),
      extentHover: createHoverExtentStyle(spec),
      marker: createMarkerStyle(spec),
      markerHover: createMarkerStyle(spec, true),
    };
    styleBundleCache.set(key, bundle);
  }
  return bundle;
};

type DatasetMapItem = IDataset | IDatasetArchiveItem;

const parseYear = (dataset: DatasetMapItem): number | null => {
  const year = Number.parseInt(dataset.aquisition_year, 10);
  return Number.isNaN(year) ? null : year;
};

const getDatasetVisualSpec = (dataset: DatasetMapItem, mode: DatasetMapColorMode): DatasetVisualSpec => {
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

// toLocaleDateString builds a fresh Intl.DateTimeFormat on every call (~60µs).
// The map formats a date for each of its ~15k features on every rebuild, so the
// formatters are hoisted and results memoised by date — the archive only holds a
// few hundred distinct acquisition dates.
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

const getDateFormatter = (hasMonth: boolean, hasDay: boolean): Intl.DateTimeFormat => {
  const key = `${hasMonth}|${hasDay}`;
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: hasMonth ? "long" : undefined,
      day: hasDay ? "numeric" : undefined,
    });
    dateFormatters.set(key, formatter);
  }
  return formatter;
};

const acquisitionDateCache = new Map<string, string>();

const formatAcquisitionDate = (dataset: DatasetMapItem): string => {
  const cacheKey = `${dataset.aquisition_year}|${dataset.aquisition_month ?? ""}|${dataset.aquisition_day ?? ""}`;
  const cached = acquisitionDateCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const year = Number.parseInt(dataset.aquisition_year, 10);
  if (Number.isNaN(year)) {
    acquisitionDateCache.set(cacheKey, "Unknown date");
    return "Unknown date";
  }

  const month = dataset.aquisition_month ? Number.parseInt(dataset.aquisition_month, 10) : 1;
  const day = dataset.aquisition_day ? Number.parseInt(dataset.aquisition_day, 10) : 1;

  const formatted = getDateFormatter(Boolean(dataset.aquisition_month), Boolean(dataset.aquisition_day)).format(
    new Date(year, Math.max(month - 1, 0), Math.max(day, 1)),
  );
  acquisitionDateCache.set(cacheKey, formatted);
  return formatted;
};

const buildTooltipTitle = (dataset: DatasetMapItem): string => {
  const place = dataset.admin_level_3 || dataset.admin_level_2 || "";
  const country = dataset.admin_level_1 || "";
  const suffix = dataset.data_access === IDataAccess.private ? " [Private]" : "";

  if (place && country) return `${place}, ${country}${suffix}`;
  if (place) return `${place}${suffix}`;
  if (country) return `${country}${suffix}`;
  return `Dataset #${dataset.id}${suffix}`;
};

interface MapRef extends OLMap {
  moveEndListener?: () => void;
  pointerMoveListener?: (evt: MapBrowserEvent) => void;
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
  onMapInteracted,
}: {
  data: DatasetMapItem[];
  hoveredItem: number | null;
  setHoveredItem: (id: number | null) => void;
  setVisibleFeatures: (ids: string[]) => void;
  filterZoomTrigger?: number;
  colorMode?: DatasetMapColorMode;
  onMapInteracted?: () => void;
}) => {
  const navigate = useNavigate();
  const mapRef = useRef<MapRef | null>(null);
  const vectorLayerExtendRef = useRef<VectorLayer<VectorSource> | null>(null);
  const vectorLayerMarkerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const mapContainer = useRef<HTMLDivElement>(null);
  // Lets hover highlighting touch just the affected features instead of scanning
  // every feature on the map on each hover.
  const featuresByIdRef = useRef<Map<number, Feature[]>>(new Map());
  const hoveredFeatureIdRef = useRef<number | null>(null);
  const { DatasetViewport, setDatasetViewport } = useDatasetMap();
  // Track previous trigger value to only zoom on explicit filter actions
  const prevZoomTriggerRef = useRef(filterZoomTrigger);
  const [mapLayersReady, setMapLayersReady] = useState(false);
  const { setNavigationSource } = useDatasetDetailsMap();
  const setHoveredItemRef = useRef(setHoveredItem);
  const setVisibleFeaturesRef = useRef(setVisibleFeatures);
  const setNavigationSourceRef = useRef(setNavigationSource);
  const navigateRef = useRef(navigate);
  const hasSeenInitialMoveEndRef = useRef(false);
  const hasTrackedInteractionRef = useRef(false);

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

      const map = new OLMap({
        target: mapContainer.current,
        layers: [],
        controls: createStandardMapControls(),
        interactions: defaultInteractions({ doubleClickZoom: false }),
        view: initialView,
      });
      mapRef.current = map as MapRef;

      // Borrowed from the shared pool; returned (not disposed) in cleanup. The
      // group already contains the OSM fallback layer.
      const basemapGroup = acquireLibertyBasemapGroup();
      map.getLayers().insertAt(0, basemapGroup);

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
        if (!hasSeenInitialMoveEndRef.current) {
          hasSeenInitialMoveEndRef.current = true;
          return;
        }
        if (!hasTrackedInteractionRef.current) {
          hasTrackedInteractionRef.current = true;
          onMapInteracted?.();
        }
      };
      map.on("moveend", moveEndListener);

      mapRef.current!.moveEndListener = moveEndListener;
      mapRef.current!.tooltip = tooltip;

      const pointerMoveListener = (evt: MapBrowserEvent) => {
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

        const nextHoveredId = hoveredFeature ? (hoveredFeature.get("id") as number) : null;
        const previousHoveredId = hoveredFeatureIdRef.current;
        hoveredFeatureIdRef.current = transitionDatasetFeatureHover(
          featuresByIdRef.current,
          previousHoveredId,
          nextHoveredId,
        );
        if (previousHoveredId !== nextHoveredId) {
          setHoveredItemRef.current(nextHoveredId);
        }

        if (hoveredFeature) {
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
        } else {
          const targetElement = map.getTargetElement();
          if (targetElement) {
            targetElement.style.cursor = "";
          }
          tooltip.getElement()?.classList.add("hidden");
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

      return () => {
        const mapWithRefs = map as MapRef;
        if (mapWithRefs.selectOnClick && mapWithRefs.selectListener) {
          mapWithRefs.selectOnClick.un("select", mapWithRefs.selectListener);
          map.removeInteraction(mapWithRefs.selectOnClick);
          mapWithRefs.selectOnClick.dispose();
        }

        if (mapWithRefs.moveEndListener) {
          map.un("moveend", mapWithRefs.moveEndListener);
        }
        if (mapWithRefs.pointerMoveListener) {
          map.un("pointermove", mapWithRefs.pointerMoveListener);
        }

        if (mapWithRefs.tooltip) {
          map.removeOverlay(mapWithRefs.tooltip);
          mapWithRefs.tooltip.dispose();
        }

        // Hand the pooled basemap back untouched — never dispose it.
        map.removeLayer(basemapGroup);
        releaseLibertyBasemapGroup(basemapGroup);

        for (const layer of [vectorLayerExtend, vectorLayerMarker]) {
          map.removeLayer(layer);
          const source = layer.getSource();
          source?.clear();
          source?.dispose();
          layer.dispose();
        }

        // Detach anything left so no layer keeps a back-reference to the map,
        // then dispose the map itself.
        map.getLayers().clear();
        map.getControls().clear();
        map.getInteractions().clear();
        map.getOverlays().clear();
        map.setTarget(undefined);
        map.dispose();

        mapRef.current = null;
        vectorLayerExtendRef.current = null;
        vectorLayerMarkerRef.current = null;
        setMapLayersReady(false);
      };
    }
    // OpenLayers map initialization is mounted once; mutable refs keep viewport and callbacks current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // console.log("updating data", data.length);
    if (mapLayersReady && vectorLayerExtendRef.current && vectorLayerMarkerRef.current && mapRef.current) {
      const vectorSourceExtend = vectorLayerExtendRef.current.getSource();
      const vectorSourceMarker = vectorLayerMarkerRef.current.getSource();

      if (!vectorSourceExtend || !vectorSourceMarker) return;

      vectorSourceExtend.clear();
      vectorSourceMarker.clear();
      // Features are rebuilt from scratch, so any previous hover highlight is gone
      // with them.
      featuresByIdRef.current = new Map();
      hoveredFeatureIdRef.current = null;

      data.forEach((dataset) => {
        if (dataset.bbox) {
          const parsedBBox = parseBBox(dataset.bbox);
          if (parsedBBox) {
            const visualSpec = getDatasetVisualSpec(dataset, colorMode);
            const {
              extent: extentStyle,
              extentHover: extentHoverStyle,
              marker: markerStyle,
              markerHover: markerHoverStyle,
            } = getStyleBundle(visualSpec);
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

            const extentGeometry = extentFeature.getGeometry();
            if (!extentGeometry) return;
            const point = extentGeometry.getInteriorPoint();
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

            featuresByIdRef.current.set(dataset.id, [extentFeature, pointFeature]);
          }
        }
      });
      // Only zoom when triggered by an explicit filter action (counter changed)
      if (filterZoomTrigger !== prevZoomTriggerRef.current) {
        prevZoomTriggerRef.current = filterZoomTrigger;
        if (vectorLayerExtendRef.current && mapRef.current) {
          const source = vectorLayerExtendRef.current.getSource();
          if (source && source.getFeatures().length > 0) {
            const extent = source.getExtent();
            if (extent) {
              mapRef.current.getView().fit(extent, {
                padding: [50, 50, 50, 50],
                maxZoom: 18,
              });
            }
          }
        }
      }
    }
  }, [data, filterZoomTrigger, colorMode, mapLayersReady]);

  // Handle feature highlighting separately. Only the features whose highlight
  // actually changed are restyled — restyling all of them made every hover redraw
  // the whole layer.
  useEffect(() => {
    hoveredFeatureIdRef.current = transitionDatasetFeatureHover(
      featuresByIdRef.current,
      hoveredFeatureIdRef.current,
      hoveredItem,
    );
  }, [hoveredItem, data, mapLayersReady]);

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

// Memoised so that typing in the archive search box — which re-renders the page
// on every keystroke — does not re-render the map subtree.
export default memo(DatasetMapOL);
