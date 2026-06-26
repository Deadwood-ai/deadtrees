import { afterEach, describe, expect, it, vi } from "vitest";
import type { WaybackItem } from "@esri/wayback-core";
import { loadGlobalWaybackItems, loadLocalWaybackItems } from "./useWaybackItems";

const point = { longitude: 10.451526, latitude: 51.165691 };

const waybackItem = (
  releaseNum: number,
  releaseDateLabel = "2022-10-04",
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadGlobalWaybackItems", () => {
  it("loads release-list candidates without local tile probing", async () => {
    const getItems = vi
      .fn()
      .mockResolvedValue([
        waybackItem(100, "2020-01-01"),
        waybackItem(300, "2022-01-01"),
        waybackItem(200, "2021-01-01"),
      ]);

    const result = await loadGlobalWaybackItems({ getItems });

    expect(getItems).toHaveBeenCalledTimes(1);
    expect(result.map((item) => item.releaseNum)).toEqual([100, 200, 300]);
    expect(result.every((item) => item.metadata === undefined)).toBe(true);
  });
});

describe("loadLocalWaybackItems", () => {
  it("keeps discovery timeouts retryable instead of caching empty imagery", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const startedAt = Date.now();
    await expect(
      loadLocalWaybackItems(point, 12, {
        itemsTimeoutMs: 10,
        getItemsWithLocalChanges: () =>
          new Promise<WaybackItem[]>(() => undefined),
      }),
    ).rejects.toThrow("Wayback imagery discovery timed out");

    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("returns local candidates without eager metadata fetching", async () => {
    const getItemsWithLocalChanges = vi
      .fn()
      .mockResolvedValue([waybackItem(31144)]);

    const result = await loadLocalWaybackItems(point, 12, {
      getItemsWithLocalChanges,
    });

    expect(result).toHaveLength(1);
    expect(result[0].releaseNum).toBe(31144);
    expect(result[0].metadata).toBeUndefined();
    expect(result[0].provider).toBeUndefined();
  });

  it("uses size-only local Wayback duplicate detection", async () => {
    const getItemsWithLocalChanges = vi
      .fn()
      .mockResolvedValue([waybackItem(31144)]);

    await loadLocalWaybackItems(point, 12, {
      getItemsWithLocalChanges,
    });

    expect(getItemsWithLocalChanges).toHaveBeenCalledWith(
      point,
      12,
      expect.objectContaining({
        onlyUseSizeToFilterDuplicates: true,
      }),
    );
  });
});
