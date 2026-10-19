import { useEffect, useRef } from "react";
import Map from "ol/Map";
import type MapBrowserEvent from "ol/MapBrowserEvent";
import View from "ol/View";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style } from "ol/style";
import { fromLonLat } from "ol/proj";
import "ol/ol.css";
import {
  acquireLibertyBasemapGroup,
  releaseLibertyBasemapGroup,
  createStandardMapControls,
} from "../../utils/basemaps";
import { palette } from "../../theme/palette";
import type { IBenchmarkSiteSummary } from "./types";

type MapEvent = MapBrowserEvent<PointerEvent | KeyboardEvent | WheelEvent>;

interface BenchmarkWorldMapProps {
  sites: IBenchmarkSiteSummary[];
  selected: string;
  onSelect: (id: string) => void;
}

const pinStyle = (radius: number, color: string) =>
  new Style({
    image: new Circle({
      radius,
      fill: new Fill({ color }),
      stroke: new Stroke({ color: "#ffffff", width: 2.5 }),
    }),
  });
const DEFAULT_PIN = pinStyle(7, palette.primary[500]);
const HOVER_PIN = pinStyle(9, palette.primary[600]);
const SELECTED_PIN = new Style({
  image: new Circle({
    radius: 10,
    fill: new Fill({ color: palette.deadwood[500] }),
    stroke: new Stroke({ color: "#ffffff", width: 3 }),
  }),
  zIndex: 10,
});

export default function BenchmarkWorldMap({
  sites,
  selected,
  onSelect,
}: BenchmarkWorldMapProps) {
  const target = useRef<HTMLDivElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const layer = useRef<VectorLayer<VectorSource> | null>(null);
  const selection = useRef(selected);
  const hovered = useRef<string | null>(null);
  const callback = useRef(onSelect);
  selection.current = selected;
  callback.current = onSelect;

  useEffect(() => {
    const element = target.current!;
    const markers = new VectorSource({
      features: sites.map(
        (site) =>
          new Feature({ geometry: new Point(fromLonLat(site.center)), site }),
      ),
    });
    const pins = new VectorLayer({
      source: markers,
      zIndex: 10,
      style: (feature) => {
        const id = (feature.get("site") as IBenchmarkSiteSummary).id;
        if (id === selection.current) return SELECTED_PIN;
        return id === hovered.current ? HOVER_PIN : DEFAULT_PIN;
      },
    });
    layer.current = pins;
    const basemapGroup = acquireLibertyBasemapGroup();
    const map = new Map({
      target: element,
      layers: [basemapGroup, pins],
      view: new View({
        center: fromLonLat([10, 18]),
        zoom: 1.7,
        minZoom: 1,
        maxZoom: 7,
      }),
      controls: createStandardMapControls({
        includeZoom: true,
        includeAttribution: true,
      }),
    });
    const siteAt = (event: MapEvent) =>
      map.forEachFeatureAtPixel(
        event.pixel,
        (feature) => feature.get("site") as IBenchmarkSiteSummary,
        { layerFilter: (candidate) => candidate === pins, hitTolerance: 6 },
      );
    const handleClick = (event: MapEvent) => {
      const site = siteAt(event);
      if (site) callback.current(site.id);
    };
    const handlePointerMove = (event: MapEvent) => {
      const site = siteAt(event);
      element.style.cursor = site ? "pointer" : "";
      if ((site?.id ?? null) !== hovered.current) {
        hovered.current = site?.id ?? null;
        markers.changed();
      }
      if (tooltip.current) {
        tooltip.current.hidden = !site;
        if (site) {
          tooltip.current.textContent = `${site.name} · ${site.type}`;
          tooltip.current.style.transform = `translate(${event.pixel[0]}px, ${event.pixel[1] - 18}px) translate(-50%, -100%)`;
        }
      }
    };
    map.on("singleclick", handleClick);
    map.on("pointermove", handlePointerMove);
    const extent = markers.getExtent();
    const fit = () => {
      map.updateSize();
      if (extent?.every(Number.isFinite))
        map.getView().fit(extent, {
          padding: [36, 36, 36, 36],
          maxZoom: 3.2,
        });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);

    return () => {
      observer.disconnect();
      map.un("singleclick", handleClick);
      map.un("pointermove", handlePointerMove);
      map.removeLayer(pins);
      pins.dispose();
      markers.clear(true);
      markers.dispose();
      map.removeLayer(basemapGroup);
      releaseLibertyBasemapGroup(basemapGroup);
      map.setTarget(undefined);
      map.dispose();
      layer.current = null;
    };
  }, [sites]);

  useEffect(() => {
    layer.current?.changed();
  }, [selected]);

  return (
    <div className="relative min-h-[320px] overflow-hidden rounded-2xl border border-gray-200 shadow-sm md:min-h-[360px]">
      <div
        ref={target}
        className="absolute inset-0"
        role="region"
        aria-label="World map of drone reference sites. Click a marker or use the site list below."
      />
      <div
        ref={tooltip}
        hidden
        className="pointer-events-none absolute left-0 top-0 z-10 whitespace-nowrap rounded-md bg-gray-900/90 px-2 py-1 text-xs font-medium text-white"
      />
    </div>
  );
}
