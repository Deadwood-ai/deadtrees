import { afterEach, describe, expect, it, vi } from "vitest";
import type { WaybackItem, WaybackMetadata } from "@esri/wayback-core";
import { loadWaybackItemsWithMetadata } from "./useWaybackItems";

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

const metadata = (date: string): WaybackMetadata => ({
  date: new Date(date).getTime(),
  provider: "Vantor",
  source: "WV02",
  resolution: 0.3,
  accuracy: 5,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadWaybackItemsWithMetadata", () => {
  it("keeps discovery timeouts retryable instead of caching empty imagery", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const startedAt = Date.now();
    await expect(
      loadWaybackItemsWithMetadata(point, 12, {
        itemsTimeoutMs: 10,
        getItemsWithLocalChanges: () =>
          new Promise<WaybackItem[]>(() => undefined),
      }),
    ).rejects.toThrow("Wayback imagery discovery timed out");

    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("keeps imagery usable when metadata exceeds the timeout", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const item = waybackItem(31144);

    const startedAt = Date.now();
    const result = await loadWaybackItemsWithMetadata(point, 12, {
      metadataTimeoutMs: 10,
      getItemsWithLocalChanges: async () => [item],
      getItemMetadata: () =>
        new Promise<WaybackMetadata | null>(() => undefined),
    });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result).toHaveLength(1);
    expect(result[0].releaseNum).toBe(31144);
    expect(result[0].metadata).toBeUndefined();
    expect(result[0].provider).toBeUndefined();
  });

  it("uses accurate local Wayback duplicate detection", async () => {
    const getItemsWithLocalChanges = vi
      .fn()
      .mockResolvedValue([waybackItem(31144)]);

    await loadWaybackItemsWithMetadata(point, 12, {
      getItemsWithLocalChanges,
      getItemMetadata: async () => metadata("2022-10-04"),
    });

    expect(getItemsWithLocalChanges).toHaveBeenCalledWith(point, 12);
  });
});
