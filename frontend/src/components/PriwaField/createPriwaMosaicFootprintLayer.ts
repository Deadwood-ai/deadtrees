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

const visibleStyle = new Style({
  stroke: new Stroke({
    color: "rgba(249, 115, 22, 0.95)",
    width: 2.5,
    lineDash: [8, 5],
  }),
});

const hiddenStyle = new Style({
  stroke: new Stroke({
    color: "rgba(100, 116, 139, 0.9)",
    width: 2,
    lineDash: [3, 5],
  }),
});

const selectedVisibleStyle = new Style({
  stroke: new Stroke({
    color: "rgba(255, 255, 255, 0.98)",
    width: 5,
  }),
});

const selectedAccentStyle = new Style({
  stroke: new Stroke({
    color: "rgba(249, 115, 22, 0.98)",
    width: 2,
    lineDash: [8, 5],
  }),
});

const selectedHiddenStyle = new Style({
  stroke: new Stroke({
    color: "rgba(15, 23, 42, 0.98)",
    width: 5,
  }),
});

const selectedHiddenAccentStyle = new Style({
  stroke: new Stroke({
    color: "rgba(203, 213, 225, 0.98)",
    width: 2,
    lineDash: [3, 5],
  }),
});

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
  feature.setStyle(
    isSelected
      ? isVisible
        ? [selectedVisibleStyle, selectedAccentStyle]
        : [selectedHiddenStyle, selectedHiddenAccentStyle]
      : isVisible
        ? visibleStyle
        : hiddenStyle,
  );

  return feature;
};

export const createPriwaMosaicFootprintLayer = () =>
  new VectorLayer({
    source: new VectorSource(),
    zIndex: 35,
  });
