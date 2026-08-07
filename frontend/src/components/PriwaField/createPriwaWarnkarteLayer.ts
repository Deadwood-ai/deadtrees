import GeoJSON from "ol/format/GeoJSON";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Fill, Stroke, Style } from "ol/style";

import type { IPriwaWarnkarteOverlay } from "../../api/priwaWarnkarte";

export const PRIWA_WARNKARTE_RED_BANDS = [
  "rgba(254, 226, 226, 0.58)",
  "rgba(254, 202, 202, 0.60)",
  "rgba(252, 165, 165, 0.62)",
  "rgba(248, 113, 113, 0.64)",
  "rgba(239, 68, 68, 0.66)",
  "rgba(220, 38, 38, 0.68)",
  "rgba(185, 28, 28, 0.70)",
  "rgba(153, 27, 27, 0.72)",
  "rgba(127, 29, 29, 0.74)",
  "rgba(69, 10, 10, 0.78)",
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
      color: band >= 7 ? "rgba(69, 10, 10, 0.82)" : "rgba(153, 27, 27, 0.62)",
      width: 1,
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
