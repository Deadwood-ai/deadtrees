import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRIWA_BASEMAP_CACHE,
  buildPriwaBasemapTilePlan,
  cachePriwaBasemapTiles,
  clearPriwaBasemapTileCache,
  createPriwaBasemapTileUrl,
  validatePriwaBasemapTilePlan,
} from "./priwaOfflineBasemap";

describe("PRIWA offline basemap helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds LGL DOP20 WMTS tile URLs", () => {
    const url = new URL(
      createPriwaBasemapTileUrl({ zoom: 18, row: 90225, col: 137017 }),
    );

    expect(url.searchParams.get("SERVICE")).toBe("WMTS");
    expect(url.searchParams.get("REQUEST")).toBe("GetTile");
    expect(url.searchParams.get("LAYER")).toBe("DOP_20_C");
    expect(url.searchParams.get("TILEMATRIX")).toBe("GoogleMapsCompatible:18");
    expect(url.searchParams.get("TILEROW")).toBe("90225");
    expect(url.searchParams.get("TILECOL")).toBe("137017");
  });

  it("plans a bounded current-map cache across a small zoom band", () => {
    const plan = buildPriwaBasemapTilePlan(
      [910_000, 6_180_000, 910_500, 6_180_500],
      18,
    );

    expect(plan.minZoom).toBe(17);
    expect(plan.maxZoom).toBe(19);
    expect(plan.tileCount).toBeGreaterThan(0);
    expect(plan.tileCount).toBe(plan.urls.length);
    expect(plan.areaKm2).toBeCloseTo(0.25);
    expect(() => validatePriwaBasemapTilePlan(plan)).not.toThrow();
  });

  it("rejects oversized basemap packages before fetching tiles", () => {
    const plan = buildPriwaBasemapTilePlan(
      [900_000, 6_170_000, 905_000, 6_175_000],
      18,
    );

    expect(() => validatePriwaBasemapTilePlan(plan)).toThrow(
      /Ausschnitt ist zu groß|zu viele Basiskarten-Kacheln/,
    );
  });

  it("caches successful tiles and reports per-tile failures", async () => {
    const put = vi.fn();
    const open = vi.fn().mockResolvedValue({ put });
    vi.stubGlobal("caches", { open });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("tile", { status: 200 }))
        .mockRejectedValueOnce(new Error("offline")),
    );
    const progress = vi.fn();
    const urls = [
      createPriwaBasemapTileUrl({ zoom: 18, row: 1, col: 1 }),
      createPriwaBasemapTileUrl({ zoom: 18, row: 1, col: 2 }),
    ];

    await expect(cachePriwaBasemapTiles(urls, progress)).resolves.toEqual({
      cached: 1,
      failed: 1,
    });
    expect(open).toHaveBeenCalledWith(PRIWA_BASEMAP_CACHE);
    expect(put).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith({
      cached: 1,
      failed: 1,
      total: 2,
    });
  });

  it("clears the dedicated basemap cache when available", async () => {
    const cacheDelete = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", { delete: cacheDelete });

    await clearPriwaBasemapTileCache();

    expect(cacheDelete).toHaveBeenCalledWith(PRIWA_BASEMAP_CACHE);
  });
});
