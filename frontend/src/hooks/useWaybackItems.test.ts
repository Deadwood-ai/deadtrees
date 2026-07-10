import { afterEach, describe, expect, it, vi } from "vitest";
import type { WaybackItem, WaybackMetadata } from "@esri/wayback-core";
import {
  enrichWaybackItemsWithMetadata,
  areWaybackCandidatesCacheable,
  loadGlobalWaybackItems,
  loadWaybackCandidates,
  readCachedCandidates,
  registerWaybackReleaseDate,
  resolveWaybackCandidate,
  writeCachedCandidates,
  type WaybackItemWithMetadata,
  type WaybackLoadProgress,
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

const enrichedItem = (
  releaseNum: number,
  releaseDateLabel: string,
  acquisitionDate?: string,
): WaybackItemWithMetadata => ({
  ...waybackItem(releaseNum, releaseDateLabel),
  acquisitionDate: acquisitionDate ? new Date(acquisitionDate) : undefined,
});

const metadata = (date: string): WaybackMetadata => ({
  date: new Date(date).getTime(),
  provider: "Maxar",
  source: "WV03",
  resolution: 0.3,
  accuracy: 5,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadWaybackCandidates", () => {
  it("keeps discovery timeouts retryable instead of caching empty imagery", async () => {
    const startedAt = Date.now();
    await expect(
      loadWaybackCandidates(point, 12, {
        discoveryTimeoutMs: 10,
        getItemsWithLocalChanges: () =>
          new Promise<WaybackItem[]>(() => undefined),
      }),
    ).rejects.toThrow("Wayback imagery discovery timed out");

    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("returns candidates enriched with acquisition dates", async () => {
    const getItemsWithLocalChanges = vi
      .fn()
      .mockResolvedValue([waybackItem(31144, "2022-10-04")]);
    const getItemMetadata = vi.fn().mockResolvedValue(metadata("2019-06-15"));

    const result = await loadWaybackCandidates(point, 12, {
      getItemsWithLocalChanges,
      getItemMetadata,
    });

    expect(getItemMetadata).toHaveBeenCalledWith(point, 12, 31144);
    expect(result).toHaveLength(1);
    // Displayed date must be the acquisition date (2019), not the release (2022).
    expect(result[0].acquisitionDate?.getUTCFullYear()).toBe(2019);
    expect(result[0].provider).toBe("Maxar");
  });

  it("collapses releases that share an acquisition date", async () => {
    // Release numbers are not temporal: the 2022 release has the LOWER number.
    const getItemsWithLocalChanges = vi
      .fn()
      .mockResolvedValue([
        waybackItem(300, "2021-01-01"),
        waybackItem(200, "2022-01-01"),
      ]);
    const getItemMetadata = vi.fn().mockResolvedValue(metadata("2019-06-15"));

    const result = await loadWaybackCandidates(point, 12, {
      getItemsWithLocalChanges,
      getItemMetadata,
    });

    expect(result).toHaveLength(1);
    // Keeps the most recently released processing of the shared capture.
    expect(result[0].releaseNum).toBe(200);
  });

  it("preserves the first release boundary when duplicate acquisitions collapse", async () => {
    const getItemsWithLocalChanges = vi
      .fn()
      .mockResolvedValue([
        waybackItem(300, "2020-01-01"),
        waybackItem(100, "2021-01-01"),
        waybackItem(200, "2022-01-01"),
      ]);
    const getItemMetadata = vi
      .fn()
      .mockImplementation(
        (_point: typeof point, _zoom: number, releaseNum: number) =>
          Promise.resolve(
            metadata(releaseNum === 300 ? "2018-07-15" : "2019-06-15"),
          ),
      );

    const result = await loadWaybackCandidates(point, 12, {
      getItemsWithLocalChanges,
      getItemMetadata,
    });

    expect(result.map((item) => item.releaseNum)).toEqual([300, 200]);
    // Release 100 is removed from the picker because release 200 has the same
    // acquisition. It still began the 2019 imagery interval, so resolving a
    // sticky selection of release 100 must not fall back to the 2018 image.
    expect(resolveWaybackCandidate(result, 100)?.releaseNum).toBe(200);
  });

  it("uses size-only local Wayback duplicate detection", async () => {
    const getItemsWithLocalChanges = vi
      .fn()
      .mockResolvedValue([waybackItem(31144)]);

    await loadWaybackCandidates(point, 12, {
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

describe("enrichWaybackItemsWithMetadata", () => {
  it("retries failed metadata lookups once before giving up", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getItemMetadata = vi
      .fn()
      .mockRejectedValueOnce(new Error("throttled"))
      .mockResolvedValue(metadata("2019-06-15"));

    const result = await enrichWaybackItemsWithMetadata(
      [enrichedItem(31144, "2022-10-04")],
      point,
      12,
      { getItemMetadata },
    );

    // First attempt failed, retry pass succeeded → the year is verified.
    expect(getItemMetadata).toHaveBeenCalledTimes(2);
    expect(result[0].acquisitionDate?.getUTCFullYear()).toBe(2019);
  });

  it("keeps items unverified when metadata fails twice", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getItemMetadata = vi
      .fn()
      .mockRejectedValue(new Error("metadata unavailable"));

    const result = await enrichWaybackItemsWithMetadata(
      [enrichedItem(31144, "2022-10-04")],
      point,
      12,
      { getItemMetadata },
    );

    expect(getItemMetadata).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0].acquisitionDate).toBeUndefined();
    expect(result[0].metadataFetchFailed).toBe(true);
    expect(areWaybackCandidatesCacheable(result)).toBe(false);
  });

  it("keeps successful empty metadata responses cacheable", async () => {
    const result = await enrichWaybackItemsWithMetadata(
      [enrichedItem(31144, "2022-10-04")],
      point,
      12,
      { getItemMetadata: vi.fn().mockResolvedValue(null) },
    );

    expect(result[0].acquisitionDate).toBeUndefined();
    expect(result[0].metadataFetchFailed).toBeUndefined();
    expect(areWaybackCandidatesCacheable(result)).toBe(true);
  });

  it("limits concurrent metadata requests to the configured pool size", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const getItemMetadata = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return metadata("2019-06-15");
    });

    const items = Array.from({ length: 10 }, (_, i) =>
      enrichedItem(100 + i, "2022-10-04"),
    );
    await enrichWaybackItemsWithMetadata(items, point, 12, {
      getItemMetadata,
      metadataConcurrency: 3,
    });

    expect(getItemMetadata).toHaveBeenCalledTimes(10);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("degrades to the release date when a metadata lookup times out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await enrichWaybackItemsWithMetadata(
      [enrichedItem(31144, "2022-10-04")],
      point,
      12,
      {
        metadataTimeoutMs: 10,
        getItemMetadata: () =>
          new Promise<WaybackMetadata | null>(() => undefined),
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0].acquisitionDate).toBeUndefined();
    expect(result[0].releaseDatetime).toBeGreaterThan(0);
  });
});

describe("load progress reporting", () => {
  it("reports the discovery phase and then real metadata counts", async () => {
    const events: WaybackLoadProgress[] = [];
    const getItemsWithLocalChanges = vi
      .fn()
      .mockResolvedValue([
        waybackItem(100, "2021-01-01"),
        waybackItem(200, "2022-01-01"),
      ]);
    const getItemMetadata = vi
      .fn()
      .mockResolvedValueOnce(metadata("2019-06-15"))
      .mockResolvedValueOnce(metadata("2020-08-01"));

    await loadWaybackCandidates(point, 12, {
      getItemsWithLocalChanges,
      getItemMetadata,
      onProgress: (p) => events.push(p),
    });

    expect(events[0]).toEqual({ phase: "discovery" });
    expect(events[1]).toEqual({ phase: "metadata", done: 0, total: 2 });
    expect(events.at(-1)).toEqual({ phase: "metadata", done: 2, total: 2 });
  });
});

describe("candidate cache", () => {
  const fakeStorage = () => {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  };

  it("round-trips candidates with revived acquisition dates", () => {
    const storage = fakeStorage();
    const items = [
      {
        ...waybackItem(200, "2022-01-01"),
        metadata: metadata("2019-06-15"),
        acquisitionDate: new Date("2019-06-15"),
        provider: "Maxar",
      } as WaybackItemWithMetadata,
    ];

    writeCachedCandidates(5, 7, items, storage);
    const revived = readCachedCandidates(5, 7, storage);

    expect(revived).toHaveLength(1);
    expect(revived?.[0].acquisitionDate).toBeInstanceOf(Date);
    expect(revived?.[0].acquisitionDate?.getUTCFullYear()).toBe(2019);
    expect(revived?.[0].provider).toBe("Maxar");
  });

  it("misses for other tiles and expired entries", () => {
    const storage = fakeStorage();
    writeCachedCandidates(5, 7, [], storage);

    expect(readCachedCandidates(6, 7, storage)).toBeNull();

    // Expired entry: pretend 25h have passed since the write
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60 * 1000);
    expect(readCachedCandidates(5, 7, storage)).toBeNull();
  });
});

describe("loadGlobalWaybackItems", () => {
  it("loads the unverified release list sorted ascending", async () => {
    const getItems = vi
      .fn()
      .mockResolvedValue([
        waybackItem(100, "2020-01-01"),
        waybackItem(300, "2022-01-01"),
        waybackItem(200, "2021-01-01"),
      ]);

    const result = await loadGlobalWaybackItems({ getItems });

    expect(result.map((item) => item.releaseNum)).toEqual([100, 200, 300]);
    expect(result.every((item) => item.acquisitionDate === undefined)).toBe(
      true,
    );
  });
});

describe("resolveWaybackCandidate", () => {
  // ESRI release numbers are NOT ordered by time — mirror that here.
  const candidates = [
    enrichedItem(48376, "2019-05-01", "2019-05-01"),
    enrichedItem(7110, "2022-07-28", "2022-07-28"),
    enrichedItem(57965, "2023-05-28", "2023-05-28"),
  ];

  it("returns the exact candidate when selected directly", () => {
    expect(resolveWaybackCandidate(candidates, 7110)?.releaseNum).toBe(7110);
  });

  it("maps a release between two changes to the latest change before it", () => {
    // A release published between the 2022 and 2023 changes serves the 2022
    // change's tiles at this location — regardless of its release number.
    registerWaybackReleaseDate(99001, new Date("2022-11-02").getTime());
    expect(resolveWaybackCandidate(candidates, 99001)?.releaseNum).toBe(7110);
  });

  it("maps a release newer than the newest change to that newest change", () => {
    registerWaybackReleaseDate(122, new Date("2026-06-30").getTime());
    expect(resolveWaybackCandidate(candidates, 122)?.releaseNum).toBe(57965);
  });

  it("returns null when the release predates the oldest candidate", () => {
    registerWaybackReleaseDate(99002, new Date("2014-02-20").getTime());
    expect(resolveWaybackCandidate(candidates, 99002)).toBeNull();
  });

  it("returns null when the release date is unknown", () => {
    expect(resolveWaybackCandidate(candidates, 424242)).toBeNull();
  });

  it("returns null for empty lists or no selection", () => {
    expect(resolveWaybackCandidate([], 7110)).toBeNull();
    expect(resolveWaybackCandidate(candidates, null)).toBeNull();
  });
});
