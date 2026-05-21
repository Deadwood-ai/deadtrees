import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPriwaBasemapTilePlan,
  cachePriwaBasemapTiles,
  clearPriwaBasemapTileCache,
  createPriwaBasemapTileUrl,
  createPriwaOsmTileUrl,
  getPriwaBasemapCacheName,
  validatePriwaBasemapTilePlan,
} from "./priwaOfflineBasemap";

describe("PRIWA offline basemap helpers", () => {
  const projectId = "project-1";

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds LGL DOP20 WMTS tile URLs", () => {
    const url = new URL(
      createPriwaBasemapTileUrl({ zoom: 18, row: 90225, col: 137017 }),
    );

    expect(url.searchParams.get("Service")).toBe("WMTS");
    expect(url.searchParams.get("Request")).toBe("GetTile");
    expect(url.searchParams.get("layer")).toBe("DOP_20_C");
    expect(url.searchParams.get("TileMatrix")).toBe("GoogleMapsCompatible:18");
    expect(url.searchParams.get("TileRow")).toBe("90225");
    expect(url.searchParams.get("TileCol")).toBe("137017");
    expect(url.toString()).toContain(
      "layer=DOP_20_C&style=default&tilematrixset=GoogleMapsCompatible",
    );
    expect(url.toString()).toContain(
      "TileMatrix=GoogleMapsCompatible%3A18&TileCol=137017&TileRow=90225",
    );
  });

  it("builds OpenStreetMap XYZ tile URLs", () => {
    expect(createPriwaOsmTileUrl({ zoom: 18, row: 90225, col: 137017 })).toBe(
      "https://tile.openstreetmap.org/18/137017/90225.png",
    );
  });

  it("plans a buffered current-map cache across a small zoom band", () => {
    const plan = buildPriwaBasemapTilePlan(
      [910_000, 6_180_000, 910_500, 6_180_500],
      18,
    );

    expect(plan.minZoom).toBe(17);
    expect(plan.maxZoom).toBe(19);
    expect(plan.tileCount).toBeGreaterThan(0);
    expect(plan.tileCount).toBe(plan.urls.length);
    expect(
      plan.urls.some((url) => url.includes("tile.openstreetmap.org")),
    ).toBe(true);
    expect(plan.extent3857).toEqual([909_750, 6_179_750, 910_750, 6_180_750]);
    expect(plan.areaKm2).toBeGreaterThan(0.4);
    expect(plan.areaKm2).toBeLessThan(0.5);
    expect(() => validatePriwaBasemapTilePlan(plan)).not.toThrow();
  });

  it("counts exact tile-boundary extents without an extra max tile", () => {
    const halfWorld = 20037508.342789244;
    const tileSpan = (halfWorld * 2) / 2 ** 18;
    const minX = -halfWorld + 137_000 * tileSpan;
    const maxY = halfWorld - 90_000 * tileSpan;
    const plan = buildPriwaBasemapTilePlan(
      [minX, maxY - tileSpan, minX + tileSpan, maxY],
      18,
      { bufferRatio: 0 },
    );

    expect(plan.tileCount).toBe(12);
  });

  it("rejects oversized basemap packages before building tile URLs", () => {
    const plan = buildPriwaBasemapTilePlan(
      [900_000, 6_170_000, 905_000, 6_175_000],
      18,
    );

    expect(plan.tileCount).toBeGreaterThan(0);
    expect(plan.urls).toEqual([]);
    expect(() => validatePriwaBasemapTilePlan(plan)).toThrow(
      /Ausschnitt ist zu groß|zu viele Basiskarten-Kacheln/,
    );
  });

  it("caches successful tiles and reports per-tile failures", async () => {
    const put = vi.fn();
    const open = vi.fn().mockResolvedValue({ put });
    const opaqueResponse = new Response(null);
    Object.defineProperty(opaqueResponse, "ok", { value: false });
    Object.defineProperty(opaqueResponse, "status", { value: 0 });
    Object.defineProperty(opaqueResponse, "type", { value: "opaque" });
    vi.stubGlobal("caches", { open });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(opaqueResponse)
        .mockRejectedValueOnce(new Error("offline")),
    );
    const progress = vi.fn();
    const urls = [
      createPriwaBasemapTileUrl({ zoom: 18, row: 1, col: 1 }),
      createPriwaBasemapTileUrl({ zoom: 18, row: 1, col: 2 }),
    ];

    await expect(
      cachePriwaBasemapTiles(projectId, urls, progress),
    ).resolves.toEqual({
      cached: 1,
      failed: 1,
    });
    expect(open).toHaveBeenCalledWith(getPriwaBasemapCacheName(projectId));
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

    await clearPriwaBasemapTileCache(projectId);

    expect(cacheDelete).toHaveBeenCalledWith(
      getPriwaBasemapCacheName(projectId),
    );
  });
});
