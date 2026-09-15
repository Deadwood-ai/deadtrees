import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import Feature, { type FeatureLike } from "ol/Feature";
import VectorTile from "ol/VectorTile";
import TileState from "ol/TileState";
import LayerGroup from "ol/layer/Group";
import VectorTileLayer from "ol/layer/VectorTile";
import VectorTileSource from "ol/source/VectorTile";
import MVT from "ol/format/MVT";
import MultiPolygon from "ol/geom/MultiPolygon";
import { get as getProjection } from "ol/proj";
import { apply } from "ol-mapbox-style";

import {
  acquireLibertyBasemapGroup,
  applyOpenFreeMapLibertyStyle,
  createWorldImagerySource,
  ESRI_WORLD_IMAGERY_ATTRIBUTION,
  ESRI_WORLD_IMAGERY_ATTRIBUTION_FULL,
  ESRI_WORLD_IMAGERY_ATTRIBUTION_MOBILE,
  ESRI_WORLD_IMAGERY_ATTRIBUTION_MOBILE_FULL,
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
    expect(resolveAttributions(createWorldImagerySource())).toContain(
      ESRI_WORLD_IMAGERY_ATTRIBUTION,
    );
    expect(resolveAttributions(getCachedWaybackSource(31144))).toContain(
      ESRI_WORLD_IMAGERY_ATTRIBUTION,
    );
    expect(ESRI_WORLD_IMAGERY_ATTRIBUTION).toContain(
      ESRI_WORLD_IMAGERY_ATTRIBUTION_FULL,
    );
    expect(ESRI_WORLD_IMAGERY_ATTRIBUTION).toContain(
      ESRI_WORLD_IMAGERY_ATTRIBUTION_MOBILE,
    );
    expect(ESRI_WORLD_IMAGERY_ATTRIBUTION).toContain(
      "Powered by Esri · Sources ⓘ",
    );
    expect(ESRI_WORLD_IMAGERY_ATTRIBUTION).toContain(
      ESRI_WORLD_IMAGERY_ATTRIBUTION_MOBILE_FULL,
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

describe("Liberty tile decoding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps disconnected polygons separate, including holes and style attributes", async () => {
    // Two squares, one with a hole. Default MVT RenderFeature decoding flattens
    // all three rings into one Polygon; the basemap loader must retain [2, 1].
    const bytes = readFileSync(
      new URL(
        "../../test/fixtures/mvt/disconnected-polygons.mvt",
        import.meta.url,
      ),
    );
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        status = 200;
        response = Uint8Array.from(bytes).buffer;
        onload = () => {};
        open() {}
        send() {
          this.onload();
        }
      },
    );
    const source = new VectorTileSource({ format: new MVT() });
    const group = new LayerGroup({ layers: [new VectorTileLayer({ source })] });
    await applyOpenFreeMapLibertyStyle(group);

    const projection = getProjection("EPSG:3857")!;
    const tile = new VectorTile<FeatureLike>(
      [0, 0, 0],
      TileState.IDLE,
      "/tile.mvt",
      new MVT<FeatureLike>(),
      source.getTileLoadFunction(),
    );
    tile.extent = [0, 0, 4096, 4096];
    tile.resolution = 1;
    tile.projection = projection;
    tile.load();

    expect(tile.getState()).toBe(TileState.LOADED);
    const [feature] = tile.getFeatures();
    expect(feature).toBeInstanceOf(Feature);
    expect(feature.getId()).toBe(7);
    expect(feature.get("mvt:layer")).toBe("landcover");
    expect(feature.get("class")).toBe("wood");
    const geometry = feature.getGeometry();
    expect(geometry).toBeInstanceOf(MultiPolygon);
    if (!(geometry instanceof MultiPolygon))
      throw new Error("Expected separate polygons");
    expect(geometry.getCoordinates().map((polygon) => polygon.length)).toEqual([
      2, 1,
    ]);
    expect(geometry.getArea()).toBe(16400);
  });

  it("marks failed tile requests as errors", async () => {
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        onerror = () => {};
        open() {}
        send() {
          this.onerror();
        }
      },
    );
    const source = new VectorTileSource({ format: new MVT() });
    const group = new LayerGroup({ layers: [new VectorTileLayer({ source })] });
    await applyOpenFreeMapLibertyStyle(group);
    const tile = new VectorTile<FeatureLike>(
      [0, 0, 0],
      TileState.IDLE,
      "/tile.mvt",
      new MVT<FeatureLike>(),
      source.getTileLoadFunction(),
    );
    tile.extent = [0, 0, 4096, 4096];
    tile.resolution = 1;
    tile.projection = getProjection("EPSG:3857")!;
    tile.load();
    expect(tile.getState()).toBe(TileState.ERROR);
  });
});
