import { describe, expect, it } from "vitest";
import { getCachedWaybackSource } from "./basemaps";

describe("getCachedWaybackSource", () => {
  it("returns the same source instance for the same release", () => {
    // Reusing the instance preserves the OpenLayers tile cache, so switching
    // back to a recently viewed release does not re-download its tiles.
    expect(getCachedWaybackSource(31144)).toBe(getCachedWaybackSource(31144));
  });

  it("returns distinct sources for distinct releases", () => {
    expect(getCachedWaybackSource(100)).not.toBe(getCachedWaybackSource(200));
  });

  it("evicts the least recently used source beyond the cap", () => {
    const first = getCachedWaybackSource(1);
    // fill the cache well past its bound (cap is 12)
    for (let releaseNum = 2; releaseNum <= 20; releaseNum++) {
      getCachedWaybackSource(releaseNum);
    }
    expect(getCachedWaybackSource(1)).not.toBe(first);
  });
});
