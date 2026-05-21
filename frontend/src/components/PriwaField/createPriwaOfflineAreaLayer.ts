import Feature from "ol/Feature";
import VectorLayer from "ol/layer/Vector";
import Polygon from "ol/geom/Polygon";
import VectorSource from "ol/source/Vector";
import { Fill, Stroke, Style } from "ol/style";

export const createPriwaOfflineAreaLayer = () =>
  new VectorLayer({
    source: new VectorSource(),
    zIndex: 30,
    style: new Style({
      fill: new Fill({
        color: "rgba(22, 101, 52, 0.12)",
      }),
      stroke: new Stroke({
        color: "rgba(22, 101, 52, 0.95)",
        lineDash: [8, 6],
        width: 3,
      }),
    }),
  });

export const createPriwaOfflineAreaFeature = (
  extent3857: [number, number, number, number],
) => {
  const [minX, minY, maxX, maxY] = extent3857;
  return new Feature({
    geometry: new Polygon([
      [
        [minX, minY],
        [minX, maxY],
        [maxX, maxY],
        [maxX, minY],
        [minX, minY],
      ],
    ]),
  });
};
