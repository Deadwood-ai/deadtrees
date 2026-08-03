import {
  buffer,
  featureCollection,
  point as turfPoint,
  union,
} from "@turf/turf";
import Feature from "ol/Feature";
import GeoJSON from "ol/format/GeoJSON";
import type { Geometry } from "ol/geom";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Fill, Stroke, Style, Text } from "ol/style";

import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";

export const PRIWA_BEFALLSGRUPPE_BUFFER_METERS = 15;

const groupStyle = (name: string, isSelected: boolean) =>
  new Style({
    fill: new Fill({
      color: isSelected ? "rgba(5, 150, 105, 0.20)" : "rgba(5, 150, 105, 0.05)",
    }),
    stroke: new Stroke({
      color: isSelected ? "rgba(4, 120, 87, 0.98)" : "rgba(4, 120, 87, 0.48)",
      width: isSelected ? 3 : 1.5,
      lineDash: [7, 5],
    }),
    text: isSelected
      ? new Text({
          text: name,
          font: "600 12px Inter, system-ui, sans-serif",
          fill: new Fill({ color: "#065f46" }),
          stroke: new Stroke({ color: "rgba(255,255,255,0.96)", width: 4 }),
          overflow: true,
        })
      : undefined,
  });

export const createPriwaBefallsgruppeFeature = (
  group: IPriwaBefallsgruppe,
  points: IPriwaPoint[],
  isSelected = false,
) => {
  const pointsById = new Map(points.map((point) => [point.id, point]));
  const bufferedTrees = group.treeIds.flatMap((treeId) => {
    const tree = pointsById.get(treeId);
    if (!tree) return [];
    const buffered = buffer(
      turfPoint([tree.lon, tree.lat]),
      PRIWA_BEFALLSGRUPPE_BUFFER_METERS,
      {
        units: "meters",
        steps: 16,
      },
    );
    return buffered ? [buffered] : [];
  });
  if (bufferedTrees.length === 0) return null;

  const dissolved =
    bufferedTrees.length === 1
      ? bufferedTrees[0]
      : union(featureCollection(bufferedTrees));
  if (!dissolved) return null;

  const feature = new GeoJSON().readFeature(dissolved, {
    dataProjection: "EPSG:4326",
    featureProjection: "EPSG:3857",
  }) as Feature<Geometry>;
  feature.setProperties({
    groupId: group.id,
    groupName: group.name,
    treeIds: group.treeIds,
  });
  feature.setStyle(groupStyle(group.name, isSelected));
  return feature;
};

export const createPriwaBefallsgruppeLayer = () =>
  new VectorLayer({
    source: new VectorSource(),
    zIndex: 35,
  });
