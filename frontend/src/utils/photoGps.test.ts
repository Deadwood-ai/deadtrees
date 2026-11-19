import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { hasGpsPosition } from "./photoGps";

// Shared with shared/tests/test_photo_gps.py, so the browser and the server agree on every case.
const fixtures = new URL("../../test/fixtures/photo-gps/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", fixtures), "utf8")) as {
  cases: { file: string; has_gps: boolean | null; note: string }[];
};
const bytes = (file: string) => new Uint8Array(readFileSync(new URL(file, fixtures)));

describe("hasGpsPosition", () => {
  it.each(manifest.cases)("$file: $note", ({ file, has_gps }) => {
    expect(hasGpsPosition(bytes(file))).toBe(has_gps);
  });

  it("does not judge formats it cannot parse", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(hasGpsPosition(png)).toBeNull();
  });

  it("does not judge a TIFF whose metadata lies beyond the bytes read", () => {
    const tif = bytes("no-gps-metadata-at-end.tif");
    expect(hasGpsPosition(tif)).toBe(false);
    expect(hasGpsPosition(tif.subarray(0, 64))).toBeNull();
  });
});
