import { useState, useEffect } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  getWaybackItems,
  getWaybackItemsWithLocalChanges,
  getMetadata,
  long2tile,
  lat2tile,
  type WaybackItem,
  type WaybackMetadata,
} from "@esri/wayback-core";
import {
  DEFAULT_WAYBACK_RELEASE,
  DEFAULT_WAYBACK_RELEASE_DATETIME,
} from "../utils/basemaps";

/**
 * ESRI World Imagery Wayback integration.
 *
 * ESRI has two different dates per release:
 * - Release date: when ESRI published a global World Imagery snapshot. A new
 *   release is cut whenever *any* region changes, so for a location that did
 *   not change the release date runs years ahead of reality.
 * - Acquisition date: when the imagery at a specific location was captured.
 *   Only available from ESRI's per-release metadata service.
 *
 * The model here is a single, atomic, per-location candidate list:
 * 1. Change detection (`getWaybackItemsWithLocalChanges`) finds the releases
 *    where the imagery at the map center actually changed. Candidates
 *    partition the release axis: between two changes every release serves
 *    byte-identical tiles, so ANY release resolves to the latest candidate at
 *    or before it (see `resolveWaybackCandidate`).
 * 2. Every candidate is enriched with its acquisition metadata (bounded
 *    concurrency, one retry pass) and the list is deduplicated by acquisition
 *    date before it is returned. The UI never sees a partially-verified list,
 *    so derived UI (year dots, labels, auto-match) is stable per location.
 * 3. Only if discovery fails outright do we fall back to the global release
 *    list, whose dates are unverified (release dates).
 */

// Discovery probes the tilemap of every Wayback release (~150) and regularly
// needs >10s on a normal connection; a tight timeout fails wholesale and
// forces the unverified fallback.
export const WAYBACK_DISCOVERY_TIMEOUT_MS = 30_000;
export const WAYBACK_METADATA_TIMEOUT_MS = 10_000;
// ESRI throttles bursts of metadata queries; a small worker pool with a retry
// pass is far more reliable than firing every request at once.
export const WAYBACK_METADATA_CONCURRENCY = 6;
export const WAYBACK_CANDIDATE_DISCOVERY_ZOOM = 12;
export const WAYBACK_CANDIDATE_DEBOUNCE_MS = 1_000;

/**
 * Extended WaybackItem with actual acquisition metadata
 */
export interface WaybackItemWithMetadata extends WaybackItem {
  metadata?: WaybackMetadata;
  /** Verified acquisition date (from metadata.date); undefined = unverified */
  acquisitionDate?: Date;
  /** Provider name (e.g., "Maxar", "Airbus") */
  provider?: string;
  /** Source/satellite name (e.g., "WV03", "Pleiades") */
  source?: string;
  /** Resolution in meters */
  resolution?: number;
}

type WaybackPoint = {
  longitude: number;
  latitude: number;
};

/**
 * Loading progress for the candidate pipeline. Discovery (tilemap probing
 * inside wayback-core) has no per-request hooks, so it reports as a phase;
 * metadata enrichment reports real per-item counts.
 */
export type WaybackLoadProgress =
  | { phase: "discovery" }
  | { phase: "metadata"; done: number; total: number };

interface LoadWaybackItemsOptions {
  discoveryTimeoutMs?: number;
  metadataTimeoutMs?: number;
  metadataConcurrency?: number;
  getItems?: typeof getWaybackItems;
  getItemsWithLocalChanges?: typeof getWaybackItemsWithLocalChanges;
  getItemMetadata?: typeof getMetadata;
  signal?: AbortSignal;
  onProgress?: (progress: WaybackLoadProgress) => void;
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeoutHandle = globalThis.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        globalThis.clearTimeout(timeoutHandle);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeoutHandle);
        reject(error);
      },
    );
  });

/**
 * Release dates for every release the app has seen, keyed by release number.
 * ESRI release numbers are NOT ordered by time, so resolving which candidate
 * covers a selected release requires its release DATE — including for
 * selections that are no longer in the current candidate list (the hardcoded
 * default release, or a candidate from a previously visited map tile).
 */
const releaseDatetimeByNum = new Map<number, number>([
  [DEFAULT_WAYBACK_RELEASE, DEFAULT_WAYBACK_RELEASE_DATETIME],
]);

export const registerWaybackReleaseDate = (
  releaseNum: number,
  releaseDatetime: number,
): void => {
  releaseDatetimeByNum.set(releaseNum, releaseDatetime);
};

const toWaybackItemWithMetadata = (
  item: WaybackItem,
  metadata: WaybackMetadata | null | undefined,
): WaybackItemWithMetadata => {
  if (item.releaseDatetime) {
    registerWaybackReleaseDate(item.releaseNum, item.releaseDatetime);
  }
  return {
    ...item,
    metadata: metadata ?? undefined,
    acquisitionDate: metadata?.date ? new Date(metadata.date) : undefined,
    provider: metadata?.provider,
    source: metadata?.source,
    resolution: metadata?.resolution,
  };
};

const sortWaybackItemsAscending = (
  items: WaybackItemWithMetadata[],
): WaybackItemWithMetadata[] =>
  [...items].sort((a, b) => {
    const dateA = a.acquisitionDate?.getTime() || a.releaseDatetime || 0;
    const dateB = b.acquisitionDate?.getTime() || b.releaseDatetime || 0;
    return dateA - dateB;
  });

const dedupeWaybackItems = (
  items: WaybackItemWithMetadata[],
): WaybackItemWithMetadata[] => {
  const dateMap = new Map<string, WaybackItemWithMetadata>();
  items.forEach((item) => {
    const dateKey =
      item.acquisitionDate?.toISOString() ||
      item.releaseDateLabel ||
      String(item.releaseNum);
    const existing = dateMap.get(dateKey);
    // Keep the most recently *released* item per acquisition date (latest
    // processing of the same capture). Release numbers are not temporal.
    if (!existing || item.releaseDatetime > existing.releaseDatetime) {
      dateMap.set(dateKey, item);
    }
  });

  return sortWaybackItemsAscending(Array.from(dateMap.values()));
};

/**
 * Fetch acquisition metadata for every item with a small worker pool, then
 * retry the failures once. Items that still fail keep `acquisitionDate`
 * undefined (unverified) — they stay selectable but are excluded from
 * verified-year UI.
 */
export const enrichWaybackItemsWithMetadata = async (
  items: WaybackItemWithMetadata[],
  point: WaybackPoint,
  zoomLevel: number,
  {
    metadataTimeoutMs = WAYBACK_METADATA_TIMEOUT_MS,
    metadataConcurrency = WAYBACK_METADATA_CONCURRENCY,
    getItemMetadata = getMetadata,
    onProgress,
  }: Pick<
    LoadWaybackItemsOptions,
    "metadataTimeoutMs" | "metadataConcurrency" | "getItemMetadata" | "onProgress"
  > = {},
): Promise<WaybackItemWithMetadata[]> => {
  const resolved = new Map<number, WaybackMetadata | null>();
  onProgress?.({ phase: "metadata", done: 0, total: items.length });

  const runPass = async (
    passItems: WaybackItemWithMetadata[],
  ): Promise<WaybackItemWithMetadata[]> => {
    const queue = [...passItems];
    const failed: WaybackItemWithMetadata[] = [];
    const workers = Array.from(
      { length: Math.min(metadataConcurrency, queue.length) },
      async () => {
        for (
          let item = queue.shift();
          item !== undefined;
          item = queue.shift()
        ) {
          try {
            const metadata = await withTimeout(
              getItemMetadata(point, zoomLevel, item.releaseNum),
              metadataTimeoutMs,
              `Wayback metadata timed out after ${metadataTimeoutMs}ms for release ${item.releaseNum}`,
            );
            resolved.set(item.releaseNum, metadata);
            onProgress?.({
              phase: "metadata",
              done: resolved.size,
              total: items.length,
            });
          } catch {
            failed.push(item);
          }
        }
      },
    );
    await Promise.all(workers);
    return failed;
  };

  const failedOnce = await runPass(items);
  const failedTwice = failedOnce.length > 0 ? await runPass(failedOnce) : [];
  failedTwice.forEach((item) => {
    console.warn(
      `Wayback metadata unavailable for release ${item.releaseNum}; keeping unverified release date`,
    );
  });

  return items.map((item) =>
    toWaybackItemWithMetadata(item, resolved.get(item.releaseNum)),
  );
};

/**
 * The per-location candidate list: change-detected releases, fully enriched
 * with acquisition metadata and deduplicated by acquisition date.
 */
export const loadWaybackCandidates = async (
  point: WaybackPoint,
  zoomLevel: number,
  {
    discoveryTimeoutMs = WAYBACK_DISCOVERY_TIMEOUT_MS,
    metadataTimeoutMs,
    metadataConcurrency,
    getItemsWithLocalChanges = getWaybackItemsWithLocalChanges,
    getItemMetadata,
    signal,
    onProgress,
  }: LoadWaybackItemsOptions = {},
): Promise<WaybackItemWithMetadata[]> => {
  onProgress?.({ phase: "discovery" });
  const items = await withTimeout(
    getItemsWithLocalChanges(point, zoomLevel, {
      signal,
      onlyUseSizeToFilterDuplicates: true,
    }),
    discoveryTimeoutMs,
    `Wayback imagery discovery timed out after ${discoveryTimeoutMs}ms`,
  );

  if (items.length === 0) return [];

  const enriched = await enrichWaybackItemsWithMetadata(
    items.map((item) => toWaybackItemWithMetadata(item, undefined)),
    point,
    zoomLevel,
    { metadataTimeoutMs, metadataConcurrency, getItemMetadata, onProgress },
  );

  return dedupeWaybackItems(enriched);
};

/**
 * Fallback when discovery fails outright: the global release list. Its dates
 * are release dates (unverified) — callers should present them as such.
 */
export const loadGlobalWaybackItems = async ({
  getItems = getWaybackItems,
}: Pick<LoadWaybackItemsOptions, "getItems"> = {}): Promise<
  WaybackItemWithMetadata[]
> => {
  const items = await getItems();
  return dedupeWaybackItems(
    items.map((item) => toWaybackItemWithMetadata(item, undefined)),
  );
};

// ---------------------------------------------------------------------------
// Persistent per-tile candidate cache. Discovery + enrichment take 10-30s, so
// cache the finished list in localStorage: revisiting an area (or reloading
// the page) is instant. ESRI cuts new releases roughly monthly — a 24h TTL is
// comfortably fresh.
// ---------------------------------------------------------------------------
const CANDIDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const candidateCacheKey = (column: number, row: number) =>
  `wayback-candidates:${WAYBACK_CANDIDATE_DISCOVERY_ZOOM}:${column}:${row}`;

export const readCachedCandidates = (
  column: number,
  row: number,
  storage: Pick<Storage, "getItem" | "removeItem"> | undefined = globalThis.localStorage,
): WaybackItemWithMetadata[] | null => {
  try {
    const raw = storage?.getItem(candidateCacheKey(column, row));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      savedAt: number;
      items: (Omit<WaybackItemWithMetadata, "acquisitionDate"> & {
        acquisitionDate?: string;
      })[];
    };
    if (Date.now() - parsed.savedAt > CANDIDATE_CACHE_TTL_MS) {
      storage?.removeItem(candidateCacheKey(column, row));
      return null;
    }
    return parsed.items.map((item) =>
      // Revive Date fields and re-register release dates for resolution.
      toWaybackItemWithMetadata(item as WaybackItem, item.metadata),
    );
  } catch {
    return null;
  }
};

export const writeCachedCandidates = (
  column: number,
  row: number,
  items: WaybackItemWithMetadata[],
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void => {
  try {
    storage?.setItem(
      candidateCacheKey(column, row),
      JSON.stringify({ savedAt: Date.now(), items }),
    );
  } catch {
    // Storage full or unavailable — the in-memory query cache still applies.
  }
};

/**
 * Resolve which candidate's imagery a given release actually shows at this
 * location: the latest candidate released at or before it. Change detection
 * guarantees releases between two candidates serve identical tiles.
 *
 * Comparison is by release DATE (release numbers are not temporal). Returns
 * null when the release predates the oldest candidate (no imagery that old
 * at this location), its date is unknown, or the list is empty.
 */
export const resolveWaybackCandidate = (
  items: WaybackItemWithMetadata[],
  releaseNum: number | null,
): WaybackItemWithMetadata | null => {
  if (releaseNum === null) return null;

  const exact = items.find((item) => item.releaseNum === releaseNum);
  if (exact) return exact;

  const releaseDatetime = releaseDatetimeByNum.get(releaseNum);
  if (releaseDatetime === undefined) return null;

  let best: WaybackItemWithMetadata | null = null;
  for (const item of items) {
    if (
      item.releaseDatetime <= releaseDatetime &&
      (best === null || item.releaseDatetime > best.releaseDatetime)
    ) {
      best = item;
    }
  }
  return best;
};

/**
 * Hook: per-location Wayback candidates for the map center.
 *
 * The map center is debounced (1s) and mapped to a coarse Wayback tile; the
 * candidate query is keyed by that tile, so panning within ~10km reuses the
 * cached list and crossing a tile boundary loads the neighbouring one. While
 * a new tile loads, the previous list stays on screen (placeholder data), so
 * selection-derived UI never collapses mid-pan.
 */
export const useWaybackItemsDebounced = (
  longitude: number | undefined,
  latitude: number | undefined,
  enabled: boolean = true,
) => {
  const [stablePoint, setStablePoint] = useState<{
    lon: number;
    lat: number;
    column: number;
    row: number;
  } | null>(null);
  const [progress, setProgress] = useState<WaybackLoadProgress | null>(null);

  useEffect(() => {
    if (!enabled || longitude === undefined || latitude === undefined) return;

    const handle = globalThis.setTimeout(() => {
      const column = long2tile(longitude, WAYBACK_CANDIDATE_DISCOVERY_ZOOM);
      const row = lat2tile(latitude, WAYBACK_CANDIDATE_DISCOVERY_ZOOM);
      // Keep the previous object when the tile is unchanged so the query key
      // (and everything derived from it) stays stable while panning in-tile.
      setStablePoint((prev) =>
        prev && prev.column === column && prev.row === row
          ? prev
          : { lon: longitude, lat: latitude, column, row },
      );
    }, WAYBACK_CANDIDATE_DEBOUNCE_MS);

    return () => globalThis.clearTimeout(handle);
  }, [longitude, latitude, enabled]);

  const candidatesQuery = useQuery({
    queryKey: ["wayback-candidates", stablePoint?.column, stablePoint?.row],
    queryFn: async ({ signal }): Promise<WaybackItemWithMetadata[]> => {
      const { lon, lat, column, row } = stablePoint as NonNullable<
        typeof stablePoint
      >;

      const cached = readCachedCandidates(column, row);
      if (cached) return cached;

      const candidates = await loadWaybackCandidates(
        { longitude: lon, latitude: lat },
        WAYBACK_CANDIDATE_DISCOVERY_ZOOM,
        { signal, onProgress: setProgress },
      );
      writeCachedCandidates(column, row, candidates);
      return candidates;
    },
    enabled: enabled && stablePoint !== null,
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    placeholderData: keepPreviousData,
    retry: 1,
  });

  // Unverified fallback, fetched only after discovery has failed for good.
  const fallbackQuery = useQuery({
    queryKey: ["wayback-items-global"],
    queryFn: () => loadGlobalWaybackItems(),
    enabled: enabled && candidatesQuery.isError,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
  });

  const candidates = candidatesQuery.data ?? [];
  const isUnverifiedFallback =
    candidatesQuery.isError && candidates.length === 0;
  const data = isUnverifiedFallback ? (fallbackQuery.data ?? []) : candidates;

  const isFetching = candidatesQuery.isFetching || fallbackQuery.isFetching;

  return {
    data,
    /** First discovery for this area still in flight (nothing to show yet) */
    isLoading:
      candidatesQuery.isPending && enabled && stablePoint !== null &&
      data.length === 0,
    isFetching,
    /** Pipeline progress while fetching (discovery phase / metadata counts) */
    progress: isFetching ? progress : null,
    /** Dates in `data` are unverified release dates (discovery failed) */
    isUnverifiedFallback,
    error: candidatesQuery.error ?? fallbackQuery.error ?? null,
  };
};
