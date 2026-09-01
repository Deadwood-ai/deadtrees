import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPriwaBasemapTilePlan,
  cachePriwaBasemapTiles,
  clearPriwaBasemapTileCache,
  createPriwaBasemapTileUrl,
  createPriwaTopographicTileUrl,
  getPriwaBasemapSelectionExtent,
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

  it("builds topographic XYZ tile URLs", () => {
    expect(
      createPriwaTopographicTileUrl({ zoom: 18, row: 90225, col: 137017 }),
    ).toBe(
      "https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR/18/90225/137017.png",
    );
  });

  it("uses the largest centered square inside the selection inset", () => {
    expect(getPriwaBasemapSelectionExtent([0, 0, 1_000, 500])).toEqual([
      355, 105, 645, 395,
    ]);
    expect(getPriwaBasemapSelectionExtent([0, 0, 500, 1_000])).toEqual([
      40, 290, 460, 710,
    ]);
  });

  it("plans a 300 hectare field package across every offline zoom level", () => {
    const plan = buildPriwaBasemapTilePlan([
      908_694, 6_178_694, 911_306, 6_181_306,
    ]);

    expect(plan.minZoom).toBe(16);
    expect(plan.maxZoom).toBe(20);
    expect(plan.tileCount).toBeGreaterThan(0);
    expect(plan.tileCount).toBe(plan.urls.length);
    expect(
      plan.urls.some(
        (url) => new URL(url).hostname === "sgx.geodatenzentrum.de",
      ),
    ).toBe(true);
    expect(plan.extent3857).toEqual([908_694, 6_178_694, 911_306, 6_181_306]);
    expect(plan.areaKm2).toBeGreaterThan(2.95);
    expect(plan.areaKm2).toBeLessThanOrEqual(3);
    expect(() => validatePriwaBasemapTilePlan(plan)).not.toThrow();
  });

  it("counts exact tile-boundary extents without an extra max tile", () => {
    const halfWorld = 20037508.342789244;
    const tileSpan = (halfWorld * 2) / 2 ** 18;
    const minX = -halfWorld + 137_000 * tileSpan;
    const maxY = halfWorld - 90_000 * tileSpan;
    const plan = buildPriwaBasemapTilePlan([
      minX,
      maxY - tileSpan,
      minX + tileSpan,
      maxY,
    ]);

    expect(plan.tileCount).toBe(30);
  });

  it("rejects oversized basemap packages before building tile URLs", () => {
    const plan = buildPriwaBasemapTilePlan([
      900_000, 6_170_000, 905_000, 6_175_000,
    ]);

    expect(plan.tileCount).toBeGreaterThan(0);
    expect(plan.urls).toEqual([]);
    expect(() => validatePriwaBasemapTilePlan(plan)).toThrow(
      /Ausschnitt ist zu groß|zu viele Basiskarten-Kacheln/,
    );
  });

  it("caches successful tiles and reports per-tile failures", async () => {
    const put = vi.fn();
    const match = vi.fn().mockResolvedValue(undefined);
    const open = vi.fn().mockResolvedValue({ match, put });
    vi.stubGlobal("caches", { open });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("tile", {
          headers: { "content-type": "image/png" },
          status: 200,
        }),
      )
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
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
    const firstRequest = fetchMock.mock.calls[0][0] as Request;
    expect(firstRequest.mode).toBe("cors");
    expect(firstRequest.credentials).toBe("omit");
    expect(put).toHaveBeenCalledTimes(1);
    const storedResponse = put.mock.calls[0][1] as Response;
    expect(storedResponse.type).toBe("default");
    expect(storedResponse.headers.get("content-type")).toBe("image/png");
    await expect(storedResponse.text()).resolves.toBe("tile");
    expect(progress).toHaveBeenLastCalledWith({
      cached: 1,
      failed: 1,
      total: 2,
    });
  });

  it("starts several tile downloads without waiting for the first response", async () => {
    const put = vi.fn();
    const match = vi.fn().mockResolvedValue(undefined);
    const open = vi.fn().mockResolvedValue({ match, put });
    vi.stubGlobal("caches", { open });

    let releaseFirstRequest: () => void = () => undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirstRequest = () => resolve(new Response("first"));
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValue(new Response("next"));
    vi.stubGlobal("fetch", fetchMock);
    const urls = Array.from({ length: 4 }, (_, index) =>
      createPriwaBasemapTileUrl({ zoom: 18, row: 1, col: index + 1 }),
    );

    const cachePromise = cachePriwaBasemapTiles(projectId, urls);
    await Promise.resolve();
    await Promise.resolve();
    const requestsStartedTogether = fetchMock.mock.calls.length;
    releaseFirstRequest();
    await cachePromise;

    expect(requestsStartedTogether).toBeGreaterThan(1);
  });

  it("reuses a tile that a previous area already cached", async () => {
    const match = vi.fn().mockResolvedValue(new Response("cached"));
    const put = vi.fn();
    const open = vi.fn().mockResolvedValue({ match, put });
    const fetchMock = vi.fn();
    vi.stubGlobal("caches", { open });
    vi.stubGlobal("fetch", fetchMock);
    const url = createPriwaBasemapTileUrl({
      zoom: 18,
      row: 90_225,
      col: 137_017,
    });

    await expect(cachePriwaBasemapTiles(projectId, [url])).resolves.toEqual({
      cached: 1,
      failed: 0,
    });
    expect(match).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("replaces legacy opaque tiles with replayable CORS responses", async () => {
    const opaqueResponse = new Response(null);
    Object.defineProperty(opaqueResponse, "type", { value: "opaque" });
    const match = vi.fn().mockResolvedValue(opaqueResponse);
    const put = vi.fn();
    const cacheDelete = vi.fn().mockResolvedValue(true);
    const open = vi.fn().mockResolvedValue({ delete: cacheDelete, match, put });
    const fetchMock = vi.fn().mockResolvedValue(new Response("updated"));
    vi.stubGlobal("caches", { open });
    vi.stubGlobal("fetch", fetchMock);
    const url = createPriwaBasemapTileUrl({
      zoom: 18,
      row: 90_225,
      col: 137_017,
    });

    await expect(cachePriwaBasemapTiles(projectId, [url])).resolves.toEqual({
      cached: 1,
      failed: 0,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cacheDelete).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
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
