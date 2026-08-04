import Feature from "ol/Feature";
import { Point } from "ol/geom";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat } from "ol/proj";
import VectorSource from "ol/source/Vector";
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from "ol/style";

import { getPriwaCoordinateSourcePresentation } from "./priwaCoordinateSource";
import type { IPriwaCoordinate, IPriwaPoint, PriwaFund } from "./types";

const fundColors: Record<PriwaFund, string> = {
  ja: "rgba(220, 38, 38, 0.96)",
  ja_kein_buchdrucker: "rgba(217, 119, 6, 0.96)",
  nein: "rgba(22, 163, 74, 0.96)",
  unsicher: "rgba(217, 119, 6, 0.96)",
};

const MAX_POINT_LABEL_RESOLUTION = 2.4;

const formatPointDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
};

const pointLabel = (point: IPriwaPoint, resolution: number) => {
  if (resolution > MAX_POINT_LABEL_RESOLUTION) return undefined;
  return point.baumnr
    ? point.baumnr
    : `${point.baumart} · ${formatPointDate(point.datum)}`;
};

const pointStyle = (
  point: IPriwaPoint,
  resolution: number,
  isSelected: boolean,
  isFocused: boolean,
) => {
  const label = pointLabel(point, resolution);
  const sourceLabel =
    resolution <= MAX_POINT_LABEL_RESOLUTION
      ? getPriwaCoordinateSourcePresentation(point.coordinateSource).mapLabel
      : undefined;
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
    text: label
      ? new Text({
          text: label,
          offsetY: -24,
          font: "600 12px Inter, system-ui, sans-serif",
          fill: new Fill({ color: "#111827" }),
          stroke: new Stroke({ color: "rgba(255,255,255,0.96)", width: 4 }),
        })
      : undefined,
  });
  const sourceStyle = sourceLabel
    ? new Style({
        text: new Text({
          text: sourceLabel,
          offsetY: 19,
          font: "600 10px Inter, system-ui, sans-serif",
          fill: new Fill({ color: "#374151" }),
          backgroundFill: new Fill({ color: "rgba(255,255,255,0.9)" }),
          padding: [1, 3, 1, 3],
        }),
      })
    : null;

  const syncStyle =
    point.syncStatus && point.syncStatus !== "synced"
      ? new Style({
          image: new CircleStyle({
            radius: point.syncStatus === "failed" ? 17 : 16,
            fill: new Fill({ color: "rgba(255,255,255,0.01)" }),
            stroke: new Stroke({
              color:
                point.syncStatus === "failed"
                  ? "rgba(220, 38, 38, 0.95)"
                  : "rgba(37, 99, 235, 0.95)",
              width: 3,
              lineDash: [3, 4],
            }),
          }),
        })
      : null;

  const selectionStyle = isSelected
    ? new Style({
        image: new CircleStyle({
          radius: 16,
          fill: new Fill({ color: "rgba(255,255,255,0.01)" }),
          stroke: new Stroke({ color: "rgba(5, 150, 105, 0.98)", width: 4 }),
        }),
      })
    : null;
  const focusStyle = isFocused
    ? new Style({
        image: new CircleStyle({
          radius: 20,
          fill: new Fill({ color: "rgba(255,255,255,0.01)" }),
          stroke: new Stroke({ color: "rgba(245, 158, 11, 0.98)", width: 4 }),
        }),
      })
    : null;

  if (!point.isEstimatedLocation) {
    const styles = [
      ...(selectionStyle ? [selectionStyle] : []),
      ...(focusStyle ? [focusStyle] : []),
      ...(syncStyle ? [syncStyle] : []),
      coreStyle,
      ...(sourceStyle ? [sourceStyle] : []),
    ];
    return styles.length === 1 ? coreStyle : styles;
  }

  return [
    ...(selectionStyle ? [selectionStyle] : []),
    ...(focusStyle ? [focusStyle] : []),
    ...(syncStyle ? [syncStyle] : []),
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
    ...(sourceStyle ? [sourceStyle] : []),
  ];
};

export const createPriwaPointFeature = (
  point: IPriwaPoint,
  isSelected = false,
  isFocused = false,
) => {
  const feature = new Feature({
    geometry: new Point(fromLonLat([point.lon, point.lat])),
    point,
  });
  feature.setId(point.id);
  feature.setStyle((_feature, resolution) =>
    pointStyle(point, resolution, isSelected, isFocused),
  );
  return feature;
};

export const createPriwaPointLayer = (points: IPriwaPoint[]) =>
  new VectorLayer({
    source: new VectorSource({
      features: points.map((point) => createPriwaPointFeature(point)),
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
