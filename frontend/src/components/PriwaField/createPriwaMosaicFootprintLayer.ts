import Feature from "ol/Feature";
import { fromExtent } from "ol/geom/Polygon.js";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Stroke, Style } from "ol/style";

import parseBBox from "../../utils/parseBBox";
import type { IPriwaMosaic } from "./usePriwaMosaics";

export interface IPriwaMosaicFootprintFeatureOptions {
  mosaic: IPriwaMosaic;
  isSelected: boolean;
  isVisible: boolean;
}

const boundaryHaloStyle = new Style({
  stroke: new Stroke({
    color: "rgba(15, 23, 42, 0.9)",
    width: 5,
  }),
});

const visibleAccentStyle = new Style({
  stroke: new Stroke({
    color: "rgba(251, 146, 60, 1)",
    width: 2.5,
    lineDash: [8, 5],
  }),
});

const hiddenAccentStyle = new Style({
  stroke: new Stroke({
    color: "rgba(34, 211, 238, 1)",
    width: 2.5,
    lineDash: [3, 5],
  }),
});

const selectedHaloStyle = new Style({
  stroke: new Stroke({
    color: "rgba(255, 255, 255, 0.98)",
    width: 6,
  }),
});

const styleForFootprint = (isSelected: boolean, isVisible: boolean) => [
  isSelected ? selectedHaloStyle : boundaryHaloStyle,
  isVisible ? visibleAccentStyle : hiddenAccentStyle,
];

export const createPriwaMosaicFootprintFeature = ({
  mosaic,
  isSelected,
  isVisible,
}: IPriwaMosaicFootprintFeatureOptions) => {
  if (!mosaic.bbox) return null;

  const bbox = parseBBox(mosaic.bbox);
  if (!bbox) return null;

  const feature = new Feature({
    geometry: fromExtent(bbox).transform("EPSG:4326", "EPSG:3857"),
    mosaic,
    mosaicId: mosaic.id,
  });
  feature.setId(`priwa-mosaic-footprint-${mosaic.id}`);
  feature.setStyle(styleForFootprint(isSelected, isVisible));

  return feature;
};

export const createPriwaMosaicFootprintLayer = () =>
  new VectorLayer({
    source: new VectorSource(),
    zIndex: 35,
  });
