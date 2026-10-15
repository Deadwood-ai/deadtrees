import { useEffect, useRef } from "react";
import Map from "ol/Map";
import View from "ol/View";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style, Text } from "ol/style";
import { fromLonLat } from "ol/proj";
import {
  acquireLibertyBasemapGroup,
  releaseLibertyBasemapGroup,
  createStandardMapControls,
} from "../../utils/basemaps";
import type { IBenchmarkSiteSummary } from "./types";

interface BenchmarkWorldMapProps {
  sites: IBenchmarkSiteSummary[];
  selected: string;
  onSelect: (id: string) => void;
}
export default function BenchmarkWorldMap({
  sites,
  selected,
  onSelect,
}: BenchmarkWorldMapProps) {
  const target = useRef<HTMLDivElement>(null);
  const source = useRef<VectorSource | null>(null);
  const selection = useRef(selected);
  const callback = useRef(onSelect);
  selection.current = selected;
  callback.current = onSelect;
  useEffect(() => {
    const markers = new VectorSource({
      wrapX: false,
      features: sites.map(
        (site) =>
          new Feature({ geometry: new Point(fromLonLat(site.center)), site }),
      ),
    });
    source.current = markers;
    const pins = new VectorLayer({
      source: markers,
      zIndex: 10,
      style: (feature) => {
        const site = feature.get("site") as IBenchmarkSiteSummary;
        const active = site.id === selection.current;
        const west = site.center[0] < 0;
        return new Style({
          image: new Circle({
            radius: active ? 8 : 5,
            fill: new Fill({ color: active ? "#1b5e35" : "#6b9279" }),
            stroke: new Stroke({ color: "#fff", width: 2 }),
          }),
          text: active
            ? new Text({
                text:
                  site.datasetUrl?.match(/\/dataset\/(\d+)/)?.[1] || site.id,
                font: "600 12px Inter, sans-serif",
                offsetY: -13,
                offsetX: west ? 10 : -10,
                textAlign: west ? "left" : "right",
                fill: new Fill({ color: "#1b5e35" }),
                stroke: new Stroke({ color: "#fff", width: 4 }),
              })
            : undefined,
          zIndex: active ? 10 : 1,
        });
      },
    });
    const basemapGroup = acquireLibertyBasemapGroup();
    const map = new Map({
      target: target.current!,
      layers: [basemapGroup, pins],
      view: new View({
        center: fromLonLat([0, 12]),
        zoom: 1,
        minZoom: -2,
        maxZoom: 7,
      }),
      controls: createStandardMapControls({
        includeZoom: true,
        includeAttribution: true,
      }),
    });
    map.on("singleclick", (event) =>
      map.forEachFeatureAtPixel(
        event.pixel,
        (feature) => {
          const site = feature.get("site") as IBenchmarkSiteSummary | undefined;
          if (site) {
            callback.current(site.id);
            return true;
          }
        },
        { layerFilter: (layer) => layer === pins, hitTolerance: 8 },
      ),
    );
    map.on("pointermove", (event) => {
      if (target.current)
        target.current.style.cursor = map.hasFeatureAtPixel(event.pixel, {
          layerFilter: (layer) => layer === pins,
          hitTolerance: 6,
        })
          ? "pointer"
          : "grab";
    });
    const observer = new ResizeObserver(() => {
      map.updateSize();
      map.getView().fit([-20037508, -8000000, 20037508, 15500000], {
        size: map.getSize(),
        padding: [28, 20, 20, 20],
      });
    });
    observer.observe(target.current!);
    return () => {
      observer.disconnect();
      map.removeLayer(basemapGroup);
      releaseLibertyBasemapGroup(basemapGroup);
      map.setTarget(undefined);
      source.current = null;
    };
  }, [sites]);
  useEffect(() => {
    source.current?.changed();
  }, [selected]);
  return (
    <div className="db-world-map">
      <div
        ref={target}
        className="db-map-target"
        role="region"
        aria-label="World map of drone reference sites. Click a marker or use the site list below."
      />
      <span className="db-map-caption">Select a reference landscape</span>
    </div>
  );
}
