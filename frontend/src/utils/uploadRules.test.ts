import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  checkGeoTiffGeoreference,
  checkRawImageNames,
  gpsSample,
  isMultispectralBand,
  photosLackGps,
  rgbPhotoNames,
} from "./uploadRules";

const photos = (count: number, ext = "JPG") =>
  Array.from({ length: count }, (_, i) => `DJI_${i}.${ext}`);

describe("checkRawImageNames", () => {
  it.each([
    "DJI_20260814112011_0103_MS_G.TIF",
    "a/IMG_180413_080658_0000_GRE.TIF",
    "x_nir.tiff",
  ])("treats %s as a multispectral band", (name) =>
    expect(isMultispectralBand(name)).toBe(true),
  );

  it.each([
    "DJI_0001_D.JPG",
    "IMG_180413_080658_0000_RGB.JPG",
    "GREEN_forest.tif",
  ])("treats %s as an RGB photo", (name) =>
    expect(isMultispectralBand(name)).toBe(false),
  );

  it("rejects archives without photos and ignores macOS metadata", () => {
    expect(() =>
      checkRawImageNames([
        "notes.txt",
        "__MACOSX/._a.JPG",
        "._b.JPG",
        "folder/",
      ]),
    ).toThrow(/no drone photos/);
  });

  it("accepts enough JPGs alongside DNG pairs without warnings", () => {
    expect(checkRawImageNames([...photos(12), ...photos(12, "DNG")])).toEqual(
      [],
    );
  });

  it("counts a JPG and its DNG twin as one photo", () => {
    expect(() => checkRawImageNames(["DJI_0001.JPG", "DJI_0001.DNG"])).toThrow(
      /only one image/,
    );
  });

  it("points a few TIFFs towards the GeoTIFF upload", () => {
    const [warning] = checkRawImageNames(["ortho_a.tif", "ortho_b.tif"]);
    expect(warning).toMatch(/only 2 photos.*upload each \.tif directly/);
  });
});

describe("checkGeoTiffGeoreference", () => {
  it("accepts an EPSG coordinate system", () => {
    const geoKeys = { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 25832 };
    expect(checkGeoTiffGeoreference({ geoKeys, hasCoordinates: true })).toEqual(
      [],
    );
  });

  it("rejects coordinates without a coordinate system", () => {
    expect(() =>
      checkGeoTiffGeoreference({ geoKeys: null, hasCoordinates: true }),
    ).toThrow(/coordinates but no coordinate system/);
  });

  it("rejects a plain image", () => {
    expect(() =>
      checkGeoTiffGeoreference({ geoKeys: {}, hasCoordinates: false }),
    ).toThrow(/no location information/);
  });

  it("leaves a CRS described only by datum keys to the server", () => {
    const geoKeys = { GTRasterTypeGeoKey: 1, GeogGeodeticDatumGeoKey: 6258 };
    expect(checkGeoTiffGeoreference({ geoKeys, hasCoordinates: true })).toEqual(
      [],
    );
  });

  it("warns, but does not block, on a custom coordinate system", () => {
    const geoKeys = { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32767 };
    expect(
      checkGeoTiffGeoreference({ geoKeys, hasCoordinates: true })[0],
    ).toMatch(/custom or local/);
  });
});

const realZips: {
  cases: {
    case: string;
    outcome: "reject" | "warn" | "pass";
    message: string | null;
    names: string[];
  }[];
} = JSON.parse(
  readFileSync(
    new URL(
      "../../../shared/tests/fixtures/real_upload_zips.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

describe("real past uploads", () => {
  it.each(realZips.cases.map((c) => [c.case, c] as const))("%s", (_, c) => {
    if (c.outcome === "reject") {
      expect(() => checkRawImageNames(c.names)).toThrow(c.message!);
      return;
    }
    const warnings = checkRawImageNames(c.names);
    if (c.outcome === "warn") {
      expect(warnings.join(" ")).toContain(c.message);
    } else {
      expect(warnings).toEqual([]);
    }
  });
});

describe("GPS sample", () => {
  it("spreads over the whole flight like the server", () => {
    const names = Array.from({ length: 101 }, (_, i) => `${String(i).padStart(3, "0")}.JPG`);
    expect(gpsSample(names)).toEqual(["000.JPG", "025.JPG", "050.JPG", "075.JPG", "100.JPG"]);
    expect(gpsSample(names.slice(0, 3))).toEqual(names.slice(0, 3));
  });

  it("rounds halves up, matching shared/upload_validation.py", () => {
    // step 2.5: index 2 * 2.5 = 5 and 1 * 2.5 = 2.5 -> 3
    const names = Array.from({ length: 11 }, (_, i) => `${String(i).padStart(2, "0")}.JPG`);
    expect(gpsSample(names)).toEqual(["00.JPG", "03.JPG", "05.JPG", "08.JPG", "10.JPG"]);
  });

  it("prefers the JPG of a DNG pair and skips band images", () => {
    expect(
      rgbPhotoNames(["a/DJI_0002.DNG", "a/DJI_0001.DNG", "a/DJI_0001.JPG", "a/DJI_0001_MS_G.TIF", "a/notes.txt"]),
    ).toEqual(["a/DJI_0001.JPG", "a/DJI_0002.DNG"]);
  });

  it("only lacks GPS when every checked photo was read without one", () => {
    expect(photosLackGps([false, false])).toBe(true);
    expect(photosLackGps([false, null])).toBe(false);
    expect(photosLackGps([])).toBe(false);
  });
});
