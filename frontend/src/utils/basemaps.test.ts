import { describe, expect, it, vi } from "vitest";
import { apply } from "ol-mapbox-style";

import {
  acquireLibertyBasemapGroup,
  createWorldImagerySource,
  getCachedWaybackSource,
  releaseLibertyBasemapGroup,
} from "./basemaps";

vi.mock("ol-mapbox-style", () => ({
  apply: vi.fn(() => Promise.resolve()),
}));

const resolveAttributions = (
  source: ReturnType<typeof createWorldImagerySource>,
) => source.getAttributions()?.(null as never) ?? [];

describe("Esri imagery attribution", () => {
  it("credits Esri and the current World Imagery data providers", () => {
    const expectedAttribution =
      "Powered by Esri | Esri, Vantor, Earthstar Geographics, and the GIS User Community";

    expect(resolveAttributions(createWorldImagerySource())).toContain(
      expectedAttribution,
    );
    expect(resolveAttributions(getCachedWaybackSource(31144))).toContain(
      expectedAttribution,
    );
  });
});

describe("Liberty basemap pool", () => {
  it("reuses returned groups without sharing a group between concurrent maps", () => {
    const first = acquireLibertyBasemapGroup();
    const concurrent = acquireLibertyBasemapGroup();

    expect(concurrent).not.toBe(first);
    expect(vi.mocked(apply)).toHaveBeenCalledTimes(2);

    first.setVisible(false);
    releaseLibertyBasemapGroup(first);

    const reused = acquireLibertyBasemapGroup();
    expect(reused).toBe(first);
    expect(reused.getVisible()).toBe(true);
    expect(vi.mocked(apply)).toHaveBeenCalledTimes(2);

    releaseLibertyBasemapGroup(reused);
    releaseLibertyBasemapGroup(concurrent);
  });
});

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
