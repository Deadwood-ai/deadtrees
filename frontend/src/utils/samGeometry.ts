import Feature from "ol/Feature.js";
import Polygon from "ol/geom/Polygon.js";

/**
 * Geometry helpers for the segmentation service. The service answers in the pixel space of the
 * view image the editor sent; these turn its polygons into map features.
 */

type PixelPolygon = { type: "Polygon"; coordinates: number[][][] };
type PixelFeature = { type: "Feature"; geometry: PixelPolygon; properties?: Record<string, unknown> };
export type PixelFeatureCollection = { type: "FeatureCollection"; features: PixelFeature[] };

type PixelToCoordinate = (pixel: [number, number]) => number[] | null;

export function toPixelFeatureCollection(raw: unknown): PixelFeatureCollection | null {
  // Older responses wrap the result under a "segmentation" key.
  const direct = raw as Partial<PixelFeatureCollection> | null | undefined;
  const nested =
    raw && typeof raw === "object" ? ((raw as Record<string, unknown>)["segmentation"] as Partial<PixelFeatureCollection>) : null;
  const fc = direct?.type === "FeatureCollection" ? direct : nested;
  return fc?.type === "FeatureCollection" && Array.isArray(fc.features) ? (fc as PixelFeatureCollection) : null;
}

export function keepLargestPolygon(fc: PixelFeatureCollection): PixelFeatureCollection {
  let best: PixelFeature | null = null;
  let bestArea = -1;
  for (const f of polygonFeatures(fc)) {
    const area = Math.abs(shoelaceArea(f.geometry.coordinates[0]));
    if (area > bestArea) {
      bestArea = area;
      best = f;
    }
  }
  return { type: "FeatureCollection", features: best ? [best] : [] };
}

/** Converts pixel polygons to map features. The service may send y downwards or negated. */
export function pixelPolygonsToFeatures(fc: PixelFeatureCollection, toCoordinate: PixelToCoordinate): Feature[] {
  const sign = ySign(fc);
  const created: Feature[] = [];
  for (const f of polygonFeatures(fc)) {
    const rings = f.geometry.coordinates
      .map((ring) => ring.map(([x, y]) => toCoordinate([x, sign * y])).filter((c): c is number[] => !!c))
      .filter((ring) => ring.length > 2);
    if (rings.length) created.push(new Feature(new Polygon(rings)));
  }
  return created;
}

function polygonFeatures(fc: PixelFeatureCollection): PixelFeature[] {
  return fc.features.filter(
    (f) => f.geometry?.type === "Polygon" && Array.isArray(f.geometry.coordinates) && f.geometry.coordinates.length > 0,
  );
}

function ySign(fc: PixelFeatureCollection): 1 | -1 {
  let neg = 0;
  let pos = 0;
  outer: for (const f of polygonFeatures(fc)) {
    for (const ring of f.geometry.coordinates) {
      for (const [, y] of ring) {
        if (y < 0) neg++;
        else if (y > 0) pos++;
        if (neg + pos > 200) break outer;
      }
    }
  }
  return neg > pos ? -1 : 1;
}

function shoelaceArea(points: number[][]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return 0.5 * sum;
}
