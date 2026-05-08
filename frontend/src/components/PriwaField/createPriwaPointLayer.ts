import Feature from "ol/Feature";
import { Point } from "ol/geom";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat } from "ol/proj";
import VectorSource from "ol/source/Vector";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";

import type { IPriwaCoordinate, IPriwaPoint, PriwaFund } from "./types";

const fundColors: Record<PriwaFund, string> = {
  ja: "rgba(220, 38, 38, 0.96)",
  ja_kein_buchdrucker: "rgba(217, 119, 6, 0.96)",
  nein: "rgba(22, 163, 74, 0.96)",
  unsicher: "rgba(217, 119, 6, 0.96)",
};

const pointStyle = (point: IPriwaPoint) => {
  const coreStyle = new Style({
    image: new CircleStyle({
      radius: point.isEstimatedLocation ? 7 : 8,
      fill: new Fill({ color: fundColors[point.fund] }),
      stroke: new Stroke({
        color: point.isEstimatedLocation
          ? "rgba(251, 191, 36, 0.98)"
          : "rgba(255, 255, 255, 0.96)",
        width: point.isEstimatedLocation ? 2 : 3,
      }),
    }),
  });

  if (!point.isEstimatedLocation) return coreStyle;

  return [
    new Style({
      image: new CircleStyle({
        radius: 13,
        fill: new Fill({ color: "rgba(251, 191, 36, 0.12)" }),
        stroke: new Stroke({
          color: "rgba(251, 191, 36, 0.9)",
          width: 2,
          lineDash: [4, 4],
        }),
      }),
    }),
    coreStyle,
  ];
};

export const createPriwaPointFeature = (point: IPriwaPoint) => {
  const feature = new Feature({
    geometry: new Point(fromLonLat([point.lon, point.lat])),
    point,
  });
  feature.setId(point.id);
  feature.setStyle(pointStyle(point));
  return feature;
};

export const createPriwaPointLayer = (points: IPriwaPoint[]) =>
  new VectorLayer({
    source: new VectorSource({
      features: points.map(createPriwaPointFeature),
    }),
    zIndex: 40,
  });

export const createPriwaPreviewLayer = () =>
  new VectorLayer({
    source: new VectorSource(),
    zIndex: 45,
    style: new Style({
      image: new CircleStyle({
        radius: 10,
        fill: new Fill({ color: "rgba(37, 99, 235, 0.28)" }),
        stroke: new Stroke({ color: "rgba(37, 99, 235, 0.98)", width: 3 }),
      }),
    }),
  });

export const createPriwaPreviewFeature = (coordinate: IPriwaCoordinate) =>
  new Feature({
    geometry: new Point(fromLonLat([coordinate.lon, coordinate.lat])),
  });
