import { useEffect, useRef } from "react";
import Feature from "ol/Feature";
import type MapBrowserEvent from "ol/MapBrowserEvent";
import Point from "ol/geom/Point";
import VectorLayer from "ol/layer/Vector";
import { Map as OLMap, View } from "ol";
import VectorSource from "ol/source/Vector";
import { fromLonLat } from "ol/proj";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";
import Overlay from "ol/Overlay";
import "ol/ol.css";

import {
  getCoarseBiomeGroup,
  type BenchmarkDatasetSite,
} from "../../data/benchmarkDatasets";
import {
  createOpenFreeMapLibertyLayerGroup,
  createStandardMapControls,
} from "../../utils/basemaps";
import { GROUND_TRUTH_COLORS } from "./GroundTruthMask";

export function DteAerialWorldSiteMap({
  sites,
}: {
  sites: BenchmarkDatasetSite[];
}) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const tooltipElementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!mapElementRef.current || !tooltipElementRef.current) return;
    const tooltipElement = tooltipElementRef.current;

    const defaultMarkerStyle = new Style({
      image: new CircleStyle({
        radius: 7,
        fill: new Fill({ color: GROUND_TRUTH_COLORS.forestCover }),
        stroke: new Stroke({ color: "#ffffff", width: 2.5 }),
      }),
    });

    const hoverMarkerStyle = new Style({
      image: new CircleStyle({
        radius: 11,
        fill: new Fill({ color: GROUND_TRUTH_COLORS.deadwood }),
        stroke: new Stroke({ color: "#ffffff", width: 3 }),
      }),
    });

    const markerSource = new VectorSource({
      features: sites.map((site) => {
        const feature = new Feature({
          geometry: new Point(fromLonLat([site.center.lon, site.center.lat])),
          datasetId: site.id,
          biome: getCoarseBiomeGroup(site.biome),
        });
        feature.setStyle(defaultMarkerStyle);
        return feature;
      }),
    });

    const markerLayer = new VectorLayer({
      source: markerSource,
      zIndex: 10,
    });

    const tooltipOverlay = new Overlay({
      element: tooltipElement,
      offset: [0, -16],
      positioning: "bottom-center",
      stopEvent: false,
    });

    const map = new OLMap({
      target: mapElementRef.current,
      layers: [createOpenFreeMapLibertyLayerGroup(), markerLayer],
      overlays: [tooltipOverlay],
      controls: createStandardMapControls({
        includeZoom: false,
        includeAttribution: true,
      }),
      view: new View({
        center: fromLonLat([10, 18]),
        zoom: 1.7,
        minZoom: 1,
        maxZoom: 6,
      }),
    });

    const extent = markerSource.getExtent();
    if (extent.every(Number.isFinite)) {
      map.getView().fit(extent, {
        padding: [28, 28, 28, 28],
        maxZoom: 3.2,
      });
    }

    let hoveredFeature: Feature | null = null;

    const handlePointerMove = (event: MapBrowserEvent<PointerEvent>) => {
      const featureAtPixel = map.forEachFeatureAtPixel(
        event.pixel,
        (feature) => feature,
      );
      const nextFeature =
        featureAtPixel instanceof Feature ? featureAtPixel : null;

      if (hoveredFeature && hoveredFeature !== nextFeature) {
        hoveredFeature.setStyle(defaultMarkerStyle);
      }

      hoveredFeature = nextFeature;
      map.getTargetElement().style.cursor = nextFeature ? "pointer" : "";

      if (!nextFeature) {
        tooltipOverlay.setPosition(undefined);
        return;
      }

      nextFeature.setStyle(hoverMarkerStyle);
      const geometry = nextFeature.getGeometry();
      if (geometry instanceof Point) {
        tooltipOverlay.setPosition(geometry.getCoordinates());
      }

      tooltipElement.textContent = `Dataset #${nextFeature.get("datasetId")} · ${nextFeature.get("biome")}`;
    };

    map.on("pointermove", handlePointerMove);

    return () => {
      map.un("pointermove", handlePointerMove);
      map.setTarget(undefined);
    };
  }, [sites]);

  return (
    <div className="relative h-80 overflow-hidden rounded-2xl bg-[#eef3f0] shadow-xl ring-1 ring-black/5">
      <div ref={mapElementRef} className="h-full w-full" />
      <div
        ref={tooltipElementRef}
        className="pointer-events-none rounded-md bg-white/95 px-2 py-1 text-xs font-semibold text-gray-900 shadow-sm ring-1 ring-black/10"
      />
    </div>
  );
}
