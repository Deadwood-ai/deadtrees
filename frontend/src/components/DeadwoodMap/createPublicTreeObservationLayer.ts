import Feature from "ol/Feature";
import { Point } from "ol/geom";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat } from "ol/proj";
import VectorSource from "ol/source/Vector";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";

import type {
  PublicTreeCondition,
  PublicTreeObservation,
} from "../../types/publicTreeObservations";

const conditionColors: Record<PublicTreeCondition, string> = {
  alive: "rgba(22, 163, 74, 0.96)",
  declining: "rgba(217, 119, 6, 0.96)",
  dead: "rgba(153, 27, 27, 0.96)",
  not_sure: "rgba(75, 85, 99, 0.96)",
};

const getObservationStyle = (condition: PublicTreeCondition) =>
  new Style({
    image: new CircleStyle({
      radius: 8,
      fill: new Fill({ color: conditionColors[condition] }),
      stroke: new Stroke({
        color: "rgba(255, 255, 255, 0.96)",
        width: 3,
      }),
    }),
  });

export const createPublicTreeObservationFeature = (
  observation: PublicTreeObservation,
) => {
  const feature = new Feature({
    geometry: new Point(fromLonLat([observation.lon, observation.lat])),
    observation,
  });
  feature.setId(observation.id);
  feature.setStyle(getObservationStyle(observation.condition));
  return feature;
};

export const createPublicTreeObservationLayer = () =>
  new VectorLayer({
    source: new VectorSource<Feature<Point>>(),
    zIndex: 55,
  });

export const syncPublicTreeObservationLayer = (
  layer: VectorLayer<VectorSource<Feature<Point>>>,
  observations: PublicTreeObservation[],
) => {
  const source = layer.getSource();
  if (!source) return;

  source.clear();
  observations.forEach((observation) => {
    source.addFeature(createPublicTreeObservationFeature(observation));
  });
};
