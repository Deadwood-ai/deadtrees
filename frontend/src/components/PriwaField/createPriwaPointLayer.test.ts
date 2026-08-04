import { describe, expect, it } from "vitest";
import { Circle as CircleStyle } from "ol/style";

import type { IPriwaPoint } from "./types";
import { createPriwaPointFeature } from "./createPriwaPointLayer";

const point: IPriwaPoint = {
  id: "tree-101",
  lat: 48.45,
  lon: 8.15,
  baumnr: "101",
  fund: "ja",
  baumart: "Fichte",
  bm: "ja",
  bohrloch: "ja",
  harz: "nein",
  grueneNadelnAmBoden: "nein",
  nadel: "grün",
  rinde: "0%",
  kv: "0%",
  name: "andere",
  datum: "2026-07-30",
  kom: "",
  capturedAt: "2026-07-30T08:00:00.000Z",
  coordinateSource: "qr",
  gps: "ja",
};

describe("createPriwaPointFeature", () => {
  it("shows the tree number and coordinate source as separate compact labels", () => {
    const feature = createPriwaPointFeature(point);
    const styles = feature.getStyleFunction()?.(feature, 0.5);
    const styleList = Array.isArray(styles) ? styles : [styles];
    const labels = styleList
      .map((style) => style?.getText()?.getText())
      .filter(Boolean);

    expect(labels).toContain("101");
    expect(labels).toContain("QR");
    expect(labels).not.toContain("Baum 101");
  });

  it.each([
    ["qr", "QR"],
    ["gps", "GPS"],
    ["map", "Karte"],
  ] as const)(
    "labels %s coordinates as %s",
    (coordinateSource, sourceLabel) => {
      const feature = createPriwaPointFeature({ ...point, coordinateSource });
      const styles = feature.getStyleFunction()?.(feature, 0.5);
      const styleList = Array.isArray(styles) ? styles : [styles];

      expect(
        styleList.map((style) => style?.getText()?.getText()).filter(Boolean),
      ).toContain(sourceLabel);
    },
  );

  it("shows mobile tree numbers nearby and hides them at overview zoom", () => {
    const feature = createPriwaPointFeature(point);
    const nearbyStyles = feature.getStyleFunction()?.(feature, 2);
    const nearbyStyleList = Array.isArray(nearbyStyles)
      ? nearbyStyles
      : [nearbyStyles];
    const overviewStyles = feature.getStyleFunction()?.(feature, 2.5);
    const overviewStyleList = Array.isArray(overviewStyles)
      ? overviewStyles
      : [overviewStyles];

    expect(
      nearbyStyleList
        .map((style) => style?.getText()?.getText())
        .filter(Boolean),
    ).toContain("101");
    expect(
      overviewStyleList.every((style) => !style?.getText()?.getText()),
    ).toBe(true);
  });

  it("marks estimated coordinates with the established dashed warning ring", () => {
    const estimatedPoint: IPriwaPoint = {
      ...point,
      coordinateSource: "gps",
      gps: "nein",
      isEstimatedLocation: true,
    };
    const feature = createPriwaPointFeature(estimatedPoint);
    const styles = feature.getStyleFunction()?.(feature, 0.5);
    const styleList = Array.isArray(styles) ? styles : [styles];

    expect(
      styleList.some((style) => {
        const image = style?.getImage();
        return (
          image instanceof CircleStyle &&
          image.getStroke()?.getLineDash()?.join() === "4,4"
        );
      }),
    ).toBe(true);
  });

  it("adds a distinct focus ring for the tree shown in the inspector", () => {
    const feature = createPriwaPointFeature(point, true, true);
    const styles = feature.getStyleFunction()?.(feature, 0.5);
    const styleList = Array.isArray(styles) ? styles : [styles];

    expect(
      styleList.some((style) => {
        const image = style?.getImage();
        return (
          image instanceof CircleStyle &&
          image.getRadius() === 20 &&
          image.getStroke()?.getColor() === "rgba(245, 158, 11, 0.98)"
        );
      }),
    ).toBe(true);
  });
});
