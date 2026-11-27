import { describe, expect, it } from "vitest";

import { withoutEmptyGeometry } from "./aoiGeometry";

describe("withoutEmptyGeometry", () => {
  it("reads an empty predicted AOI as no geometry with no usable area", () => {
    const aoi = withoutEmptyGeometry({ id: 1, geometry: { type: "MultiPolygon", coordinates: [] } });

    expect(aoi).toEqual({ id: 1, geometry: null, noUsableArea: true });
  });

  it("keeps an AOI with polygons", () => {
    const geometry = { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] };

    expect(withoutEmptyGeometry({ id: 2, geometry })).toEqual({ id: 2, geometry, noUsableArea: false });
  });
});
