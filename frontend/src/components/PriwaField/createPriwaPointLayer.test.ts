import { describe, expect, it } from "vitest";

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
  it("labels close map points with species, discovery date, and secondary tree number", () => {
    const feature = createPriwaPointFeature(point);
    const styles = feature.getStyleFunction()?.(feature, 0.5);
    const styleList = Array.isArray(styles) ? styles : [styles];
    const labels = styleList
      .map((style) => style?.getText()?.getText())
      .filter(Boolean);

    expect(labels).toContain("Fichte · 30.07.2026\nBaum 101");
  });
});
