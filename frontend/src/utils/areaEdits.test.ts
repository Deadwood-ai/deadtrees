import { describe, expect, it } from "vitest";
import Feature from "ol/Feature";
import type Geometry from "ol/geom/Geometry";
import Polygon from "ol/geom/Polygon";
import { addArea, clipToArea, removeArea } from "./areaEdits";

const square = (x: number, y: number, size: number) =>
  new Polygon([[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]);
const feature = (geometry: Geometry) => new Feature<Geometry>(geometry);
const area = (f: Feature<Geometry>) => (f.getGeometry() as Polygon).getArea();

describe("addArea", () => {
  it("merges the area with every polygon it touches and leaves others alone", () => {
    const left = feature(square(0, 0, 10));
    const right = feature(square(20, 0, 10));
    const far = feature(square(100, 100, 5));
    const edit = addArea([left, right, far], square(5, 2, 20));
    expect(edit.removed).toEqual([left, right]);
    expect(edit.added).toHaveLength(1);
    expect(area(edit.added[0])).toBe(100 + 100 + 20 * 20 - 2 * 5 * 8);
    expect(edit.added[0].get("is_new")).toBe(true);
  });

  it("adds the area alone when it touches nothing", () => {
    const edit = addArea([feature(square(0, 0, 10))], square(50, 50, 4));
    expect(edit.removed).toHaveLength(0);
    expect(area(edit.added[0])).toBe(16);
  });
});

describe("removeArea", () => {
  it("cuts a gap out of a polygon and drops polygons fully inside the area", () => {
    const forest = feature(square(0, 0, 10));
    const inside = feature(square(30, 30, 2));
    const edit = removeArea([forest, inside], square(4, 4, 2).clone());
    expect(edit.removed).toEqual([forest]);
    expect(area(edit.added[0])).toBe(100 - 4);
    expect((edit.added[0].getGeometry() as Polygon).getLinearRingCount()).toBe(2);

    const swallowed = removeArea([inside], square(29, 29, 5));
    expect(swallowed.removed).toEqual([inside]);
    expect(swallowed.added).toHaveLength(0);
  });

  it("splits a polygon cut in two into two features", () => {
    const edit = removeArea([feature(square(0, 0, 10))], new Polygon([[[4, -1], [6, -1], [6, 11], [4, 11], [4, -1]]]));
    expect(edit.added).toHaveLength(2);
    expect(edit.added.map(area).sort()).toEqual([40, 40]);
  });
});

describe("clipToArea", () => {
  it("keeps only the parts inside the area", () => {
    const clipped = clipToArea([feature(square(0, 0, 10)), feature(square(50, 50, 5))], square(5, 5, 10));
    expect(clipped).toHaveLength(1);
    expect(area(clipped[0])).toBe(25);
  });
});
