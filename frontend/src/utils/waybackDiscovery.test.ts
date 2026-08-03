import { describe, expect, it, vi } from "vitest";
import type { WaybackItem } from "@esri/wayback-core";
import { discoverWaybackItemsWithLocalChanges } from "./waybackDiscovery";

const point = { longitude: 10.451526, latitude: 51.165691 };

const waybackItem = (
  releaseNum: number,
  releaseDateLabel: string,
): WaybackItem => ({
  itemID: `item-${releaseNum}`,
  itemTitle: `World Imagery (Wayback ${releaseDateLabel})`,
  itemURL: `https://example.com/${releaseNum}/{level}/{row}/{col}`,
  metadataLayerUrl: `https://metadata.example.com/${releaseNum}`,
  metadataLayerItemID: `metadata-${releaseNum}`,
  layerIdentifier: `WB_${releaseNum}`,
  releaseNum,
  releaseDateLabel,
  releaseDatetime: new Date(releaseDateLabel).getTime(),
});

describe("discoverWaybackItemsWithLocalChanges", () => {
  it("aborts the active tilemap request before another release is probed", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );

    const work = discoverWaybackItemsWithLocalChanges(point, 12, {
      signal: controller.signal,
      fetchImpl,
      getItems: vi.fn().mockResolvedValue([
        waybackItem(300, "2022-01-01"),
        waybackItem(200, "2021-01-01"),
        waybackItem(100, "2020-01-01"),
      ]),
      getServiceBaseUrl: () => "https://wayback.example.com/MapServer",
    });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(work).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it("walks local-change releases and keeps the oldest equal-size candidate", async () => {
    const tilemaps = [
      { data: [1], select: [300], size: [10] },
      { data: [1], select: [200], size: [10] },
      { data: [1], select: [100], size: [20] },
    ];
    const fetchImpl = vi.fn().mockImplementation(() => {
      const tilemap = tilemaps.shift();
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tilemap),
      } as Response);
    });

    const result = await discoverWaybackItemsWithLocalChanges(point, 12, {
      fetchImpl,
      getItems: vi.fn().mockResolvedValue([
        waybackItem(300, "2022-01-01"),
        waybackItem(200, "2021-01-01"),
        waybackItem(100, "2020-01-01"),
      ]),
      getServiceBaseUrl: () => "https://wayback.example.com/MapServer",
    });

    expect(result.map((item) => item.releaseNum)).toEqual([200, 100]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
