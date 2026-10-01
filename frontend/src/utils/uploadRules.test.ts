import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { checkGeoTiffGeoreference, checkRawImageNames, isMultispectralBand } from "./uploadRules";

const photos = (count: number, ext = "JPG") => Array.from({ length: count }, (_, i) => `DJI_${i}.${ext}`);

describe("checkRawImageNames", () => {
  it.each(["DJI_20260814112011_0103_MS_G.TIF", "a/IMG_180413_080658_0000_GRE.TIF", "x_nir.tiff"])(
    "treats %s as a multispectral band",
    (name) => expect(isMultispectralBand(name)).toBe(true),
  );

  it.each(["DJI_0001_D.JPG", "IMG_180413_080658_0000_RGB.JPG", "GREEN_forest.tif"])(
    "treats %s as an RGB photo",
    (name) => expect(isMultispectralBand(name)).toBe(false),
  );

  it("rejects archives without photos and ignores macOS metadata", () => {
    expect(() => checkRawImageNames(["notes.txt", "__MACOSX/._a.JPG", "._b.JPG", "folder/"])).toThrow(
      /no drone photos/,
    );
  });

  it("accepts enough JPGs alongside DNG pairs without warnings", () => {
    expect(checkRawImageNames([...photos(12), ...photos(12, "DNG")])).toEqual([]);
  });

  it("points a few TIFFs towards the GeoTIFF upload", () => {
    const [warning] = checkRawImageNames(["ortho_a.tif", "ortho_b.tif"]);
    expect(warning).toMatch(/only 2 photos.*upload each \.tif directly/);
  });
});

describe("checkGeoTiffGeoreference", () => {
  it("accepts an EPSG coordinate system", () => {
    const geoKeys = { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 25832 };
    expect(checkGeoTiffGeoreference({ geoKeys, hasCoordinates: true })).toEqual([]);
  });

  it("rejects coordinates without a coordinate system", () => {
    expect(() => checkGeoTiffGeoreference({ geoKeys: null, hasCoordinates: true })).toThrow(
      /coordinates but no coordinate system/,
    );
  });

  it("rejects a plain image", () => {
    expect(() => checkGeoTiffGeoreference({ geoKeys: {}, hasCoordinates: false })).toThrow(/no location information/);
  });

  it("warns, but does not block, on a custom coordinate system", () => {
    const geoKeys = { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32767 };
    expect(checkGeoTiffGeoreference({ geoKeys, hasCoordinates: true })[0]).toMatch(/custom or local/);
  });
});

const realZips: { cases: { case: string; outcome: "reject" | "warn" | "pass"; message: string | null; names: string[] }[] } =
  JSON.parse(
    readFileSync(new URL("../../../shared/tests/fixtures/real_upload_zips.json", import.meta.url), "utf8"),
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
