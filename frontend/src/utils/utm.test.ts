import { describe, expect, it } from "vitest";
import { createUtmSquare, polygonToBBox } from "./utm";

describe("UTM geometry helpers", () => {
  it("calculates a bbox from all polygon coordinates", () => {
    expect(polygonToBBox(createUtmSquare(1000, 2000, 200))).toEqual({
      minx: 900,
      miny: 1900,
      maxx: 1100,
      maxy: 2100,
    });
  });

  it("does not depend on the first and third coordinates being bbox corners", () => {
    const geometry: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [10, 10],
          [0, 20],
          [5, 5],
          [20, 0],
          [10, 10],
        ],
      ],
    };

    expect(polygonToBBox(geometry)).toEqual({
      minx: 0,
      miny: 0,
      maxx: 20,
      maxy: 20,
    });
  });
});
