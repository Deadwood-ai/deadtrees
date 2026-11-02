import { describe, expect, it } from "vitest";
import Polygon from "ol/geom/Polygon.js";
import { captureScale, keepLargestPolygon, pixelPolygonsToFeatures, toPixelFeatureCollection } from "./samGeometry";

const square = (x: number, y: number, size: number, sign = -1) => ({
  type: "Feature" as const,
  geometry: {
    type: "Polygon" as const,
    coordinates: [[[x, sign * y], [x + size, sign * y], [x + size, sign * (y + size)], [x, sign * (y + size)], [x, sign * y]]],
  },
});

describe("samGeometry", () => {
  it("accepts a plain or wrapped feature collection and rejects anything else", () => {
    const fc = { type: "FeatureCollection", features: [] };
    expect(toPixelFeatureCollection(fc)).toEqual(fc);
    expect(toPixelFeatureCollection({ segmentation: fc })).toEqual(fc);
    expect(toPixelFeatureCollection({ error: "x" })).toBeNull();
  });

  it("keeps only the largest polygon", () => {
    const fc = toPixelFeatureCollection({ type: "FeatureCollection", features: [square(0, 0, 2), square(5, 5, 10)] })!;
    const largest = keepLargestPolygon(fc);
    expect(largest.features).toHaveLength(1);
    expect(largest.features[0].geometry.coordinates[0][0]).toEqual([5, -5]);
  });

  it("maps negated pixel y back to screen pixels before converting to map coordinates", () => {
    const fc = toPixelFeatureCollection({ type: "FeatureCollection", features: [square(10, 20, 5)] })!;
    const seen: number[][] = [];
    const [feature] = pixelPolygonsToFeatures(fc, (p) => {
      seen.push(p);
      return [p[0] * 2, p[1] * 2];
    });
    expect(seen[0]).toEqual([10, 20]);
    expect((feature.getGeometry() as Polygon).getCoordinates()[0][0]).toEqual([20, 40]);
  });

  it("keeps screen-space y as it is", () => {
    const fc = toPixelFeatureCollection({ type: "FeatureCollection", features: [square(10, 20, 5, 1)] })!;
    const [feature] = pixelPolygonsToFeatures(fc, (p) => p);
    expect((feature.getGeometry() as Polygon).getCoordinates()[0][0]).toEqual([10, 20]);
  });

  it("shrinks views wider than the service limit and keeps smaller ones", () => {
    expect(captureScale(1440, 900)).toBe(1);
    expect(captureScale(2048, 1000)).toBe(1);
    expect(captureScale(3200, 1800)).toBeCloseTo(0.64);
    expect(Math.round(3200 * captureScale(3200, 1800))).toBe(2048);
  });
});
