import { describe, expect, it } from "vitest";
import { imageFacts } from "./imageFacts";

// dataset 15544, shortened
const info = {
  COG: true,
  COG_errors: null,
  COG_warnings: null,
  Compression: "LZW",
  GEO: {
    CRS: 'PROJCS["JGD2011 / Japan Plane Rectangular CS VIII",GEOGCS["JGD2011",DATUM["Japanese_Geodetic_Datum_2011"]]]',
    Resolution: [0.023276894116074826, -0.023276894116074923],
  },
  Profile: { Bands: 4, Dtype: "uint8", Tiled: true, Width: 25735, Height: 23606, ColorInterp: ["red", "green", "blue", "alpha"] },
};

describe("imageFacts", () => {
  it("reads the facts an auditor looks at", () => {
    expect(imageFacts(info)).toEqual([
      { label: "Size", value: "25,735 × 23,606 px" },
      { label: "Resolution", value: "2.3 cm per pixel" },
      { label: "Bands", value: "red, green, blue, alpha · 8 bit" },
      { label: "File", value: "Valid COG · LZW · tiled", tone: "ok" },
      { label: "Projection", value: "JGD2011 / Japan Plane Rectangular CS VIII" },
    ]);
  });

  it("flags an invalid COG and lists what rio-cogeo reports", () => {
    const facts = imageFacts({ ...info, COG: false, COG_errors: ["The file is greater than 512xH or 512xW, but is not tiled"], COG_warnings: ["no overviews"] });
    expect(facts.filter((f) => f.tone === "warn").map((f) => f.value)).toEqual([
      "Not a valid COG · LZW · tiled",
      "The file is greater than 512xH or 512xW, but is not tiled",
      "no overviews",
    ]);
  });

  it("leaves out what it cannot read", () => {
    // a geographic projection gives the pixel size in degrees: no resolution in cm
    const degrees = { ...info, GEO: { CRS: 'GEOGCS["WGS 84",DATUM["WGS_1984"]]', Resolution: [2e-7, -2e-7] } };
    expect(imageFacts(degrees).map((f) => f.label)).toEqual(["Size", "Bands", "File", "Projection"]);
    expect(imageFacts(null)).toEqual([]);
    expect(imageFacts({ Profile: { Bands: 3 } })).toEqual([{ label: "Bands", value: "3 bands" }]);
  });
});
