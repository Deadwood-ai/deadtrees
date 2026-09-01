import GeoJSON from "ol/format/GeoJSON";
import type Map from "ol/Map";
import { isEmpty } from "ol/extent";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Fill, Stroke, Style } from "ol/style";

import type { IPriwaWarnkarteOverlay } from "../../api/priwaWarnkarte";

export const PRIWA_WARNKARTE_RED_BANDS = [
  "rgba(254, 226, 226, 0.68)",
  "rgba(254, 202, 202, 0.70)",
  "rgba(252, 165, 165, 0.72)",
  "rgba(248, 113, 113, 0.74)",
  "rgba(239, 68, 68, 0.76)",
  "rgba(220, 38, 38, 0.78)",
  "rgba(185, 28, 28, 0.80)",
  "rgba(153, 27, 27, 0.82)",
  "rgba(127, 29, 29, 0.84)",
  "rgba(69, 10, 10, 0.86)",
] as const;

export const getPriwaWarnkarteBandIndex = (probability: number) => {
  const bounded = Math.min(1, Math.max(0, probability));
  return bounded === 0 ? 0 : Math.ceil(bounded * 10) - 1;
};

export const getPriwaWarnkarteStyle = (probability: number) => {
  const band = getPriwaWarnkarteBandIndex(probability);
  return new Style({
    fill: new Fill({ color: PRIWA_WARNKARTE_RED_BANDS[band] }),
    stroke: new Stroke({
      color: "rgba(69, 10, 10, 0.18)",
      width: 0.5,
    }),
  });
};

export const createPriwaWarnkarteLayer = () =>
  new VectorLayer({
    source: new VectorSource({ wrapX: false }),
    zIndex: 25,
    style: (feature) =>
      getPriwaWarnkarteStyle(Number(feature.get("probability") ?? 0)),
  });

export const setPriwaWarnkarteLayerData = (
  layer: ReturnType<typeof createPriwaWarnkarteLayer>,
  overlay: IPriwaWarnkarteOverlay | null,
) => {
  const source = layer.getSource();
  source?.clear();
  if (!source || !overlay || overlay.features.length === 0) return;

  source.addFeatures(
    new GeoJSON().readFeatures(overlay, {
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:3857",
    }),
  );
};

export const fitPriwaWarnkarteLayer = (
  map: Map,
  layer: ReturnType<typeof createPriwaWarnkarteLayer>,
  isMobile: boolean,
) => {
  const extent = layer.getSource()?.getExtent();
  const mapSize = map.getSize();
  if (!extent || !mapSize || isEmpty(extent)) return;

  const horizontalPadding = isMobile
    ? 48
    : Math.min(360, Math.floor(mapSize[0] * 0.28));
  map.getView().fit(extent, {
    duration: 500,
    maxZoom: 18,
    padding: [96, horizontalPadding, 120, horizontalPadding],
  });
};
