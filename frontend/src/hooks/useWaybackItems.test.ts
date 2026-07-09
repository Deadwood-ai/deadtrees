import { afterEach, describe, expect, it, vi } from "vitest";
import type { WaybackItem, WaybackMetadata } from "@esri/wayback-core";
import {
  enrichWaybackItemsWithMetadata,
  loadGlobalWaybackItems,
  loadLocalWaybackItems,
  overlayAcquisitionMetadata,
  type WaybackItemWithMetadata,
} from "./useWaybackItems";

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
  provider: "Maxar",
  source: "WV03",
  resolution: 0.3,
  accuracy: 5,
});

/**
 * Never resolve — a mock metadata fetch that stands in for the real network so
 * unenriched code paths do not accidentally hit ESRI. Callers that expect
 * enrichment must provide their own resolving mock.
 */
const hangingMetadata = () => new Promise<WaybackMetadata | null>(() => undefined);

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

  it("attaches the acquisition date from location metadata", async () => {
    const getItemsWithLocalChanges = vi
      .fn()
      .mockResolvedValue([waybackItem(31144, "2022-10-04")]);
    const getItemMetadata = vi.fn().mockResolvedValue(metadata("2019-06-15"));

    const result = await loadLocalWaybackItems(point, 12, {
      getItemsWithLocalChanges,
      getItemMetadata,
    });

    expect(getItemMetadata).toHaveBeenCalledWith(point, 12, 31144);
    expect(result).toHaveLength(1);
    expect(result[0].releaseNum).toBe(31144);
    // Displayed date must be the acquisition date (2019), not the release (2022).
    expect(result[0].acquisitionDate?.getUTCFullYear()).toBe(2019);
    expect(result[0].provider).toBe("Maxar");
  });

  it("collapses releases that share an acquisition date", async () => {
    // Two distinct releases whose underlying imagery was captured on the same
    // day must not appear as two separate selectable years.
    const getItemsWithLocalChanges = vi
      .fn()
      .mockResolvedValue([
        waybackItem(200, "2021-01-01"),
        waybackItem(300, "2022-01-01"),
      ]);
    const getItemMetadata = vi.fn().mockResolvedValue(metadata("2019-06-15"));

    const result = await loadLocalWaybackItems(point, 12, {
      getItemsWithLocalChanges,
      getItemMetadata,
    });

    expect(result).toHaveLength(1);
    // Keeps the newest release number for the shared acquisition date.
    expect(result[0].releaseNum).toBe(300);
    expect(result[0].acquisitionDate?.getUTCFullYear()).toBe(2019);
  });

  it("keeps items whose metadata lookup fails, without acquisition dates", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getItemsWithLocalChanges = vi
      .fn()
      .mockResolvedValue([waybackItem(31144, "2022-10-04")]);
    const getItemMetadata = vi
      .fn()
      .mockRejectedValue(new Error("metadata unavailable"));

    const result = await loadLocalWaybackItems(point, 12, {
      getItemsWithLocalChanges,
      getItemMetadata,
    });

    expect(result).toHaveLength(1);
    expect(result[0].releaseNum).toBe(31144);
    expect(result[0].acquisitionDate).toBeUndefined();
  });

  it("uses size-only local Wayback duplicate detection", async () => {
    const getItemsWithLocalChanges = vi
      .fn()
      .mockResolvedValue([waybackItem(31144)]);

    await loadLocalWaybackItems(point, 12, {
      getItemsWithLocalChanges,
      getItemMetadata: vi.fn().mockResolvedValue(metadata("2019-06-15")),
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

describe("overlayAcquisitionMetadata", () => {
  const withoutMetadata = (
    releaseNum: number,
    releaseDateLabel: string,
  ): WaybackItemWithMetadata => ({
    ...waybackItem(releaseNum, releaseDateLabel),
    metadata: undefined,
  });

  it("overlays the acquisition date for items missing one", () => {
    const items = [withoutMetadata(200, "2021-01-01")];
    const store = new Map([[200, metadata("2019-06-15")]]);

    const result = overlayAcquisitionMetadata(items, (r) => store.get(r));

    expect(result[0].acquisitionDate?.getUTCFullYear()).toBe(2019);
    expect(result[0].provider).toBe("Maxar");
  });

  it("keeps existing acquisition dates and unresolved items untouched", () => {
    const enriched: WaybackItemWithMetadata = {
      ...waybackItem(100, "2020-01-01"),
      acquisitionDate: new Date("2018-01-01"),
    };
    const unresolved = withoutMetadata(200, "2021-01-01");

    const result = overlayAcquisitionMetadata(
      [enriched, unresolved],
      () => undefined,
    );

    expect(result[0].acquisitionDate?.getUTCFullYear()).toBe(2018);
    expect(result[1].acquisitionDate).toBeUndefined();
  });

  it("preserves array identity when no item is overlaid", () => {
    const items = [withoutMetadata(200, "2021-01-01")];

    const result = overlayAcquisitionMetadata(items, () => undefined);

    expect(result).toBe(items);
  });
});

describe("enrichWaybackItemsWithMetadata", () => {
  it("degrades to the release date when a metadata lookup times out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const item = {
      ...waybackItem(31144, "2022-10-04"),
      metadata: undefined,
    };

    const result = await enrichWaybackItemsWithMetadata([item], point, 12, {
      metadataTimeoutMs: 10,
      getItemMetadata: hangingMetadata,
    });

    expect(result).toHaveLength(1);
    expect(result[0].acquisitionDate).toBeUndefined();
    expect(result[0].releaseDatetime).toBe(item.releaseDatetime);
  });
});
