import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getWaybackItems,
  getWaybackItemsWithLocalChanges,
  getMetadata,
  long2tile,
  lat2tile,
  type WaybackItem,
  type WaybackMetadata,
} from "@esri/wayback-core";

export const WAYBACK_ITEMS_TIMEOUT_MS = 8_000;
export const WAYBACK_METADATA_TIMEOUT_MS = 3_000;

/**
 * Extended WaybackItem with actual acquisition metadata
 */
export interface WaybackItemWithMetadata extends WaybackItem {
  metadata?: WaybackMetadata;
  /** Formatted acquisition date (from metadata.date) */
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

interface LoadWaybackItemsOptions {
  itemsTimeoutMs?: number;
  metadataTimeoutMs?: number;
  getItems?: typeof getWaybackItems;
  getItemsWithLocalChanges?: typeof getWaybackItemsWithLocalChanges;
  getItemMetadata?: typeof getMetadata;
  signal?: AbortSignal;
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

const toWaybackItemWithMetadata = (
  item: WaybackItem,
  metadata: WaybackMetadata | null | undefined,
): WaybackItemWithMetadata => ({
  ...item,
  metadata: metadata ?? undefined,
  acquisitionDate: metadata?.date ? new Date(metadata.date) : undefined,
  provider: metadata?.provider,
  source: metadata?.source,
  resolution: metadata?.resolution,
});

const toWaybackItemWithoutMetadata = (
  item: WaybackItem,
): WaybackItemWithMetadata => toWaybackItemWithMetadata(item, undefined);

/**
 * Enrich Wayback items with per-location acquisition metadata.
 *
 * The Wayback release date (`releaseDatetime`/`releaseDateLabel`) is only the
 * date ESRI *published* a global World Imagery snapshot — it is not the date the
 * imagery at this location was actually captured. ESRI keeps serving the same
 * underlying imagery across many releases for areas that did not change, so the
 * release date is frequently years newer than the acquisition date (e.g. a 2019
 * swissimage orthophoto still surfaced under a 2022 release).
 *
 * We therefore query ESRI's metadata service for each candidate release at the
 * given location and attach the true acquisition date. Failures degrade
 * gracefully: an item that could not be enriched keeps `acquisitionDate`
 * undefined and callers fall back to the release date for that item only.
 */
export const enrichWaybackItemsWithMetadata = async (
  items: WaybackItemWithMetadata[],
  point: WaybackPoint,
  zoomLevel: number,
  {
    metadataTimeoutMs = WAYBACK_METADATA_TIMEOUT_MS,
    getItemMetadata = getMetadata,
    signal,
  }: Pick<
    LoadWaybackItemsOptions,
    "metadataTimeoutMs" | "getItemMetadata" | "signal"
  > = {},
): Promise<WaybackItemWithMetadata[]> => {
  const enriched = await Promise.all(
    items.map(async (item) => {
      try {
        const metadata = await withTimeout(
          getItemMetadata(point, zoomLevel, item.releaseNum),
          metadataTimeoutMs,
          `Wayback metadata timed out after ${metadataTimeoutMs}ms for release ${item.releaseNum}`,
        );
        if (signal?.aborted) return item;
        return toWaybackItemWithMetadata(item, metadata);
      } catch (error) {
        console.warn(
          `Failed to load Wayback metadata for release ${item.releaseNum}`,
          error,
        );
        return item;
      }
    }),
  );

  return dedupeWaybackItems(enriched);
};

/**
 * Overlay resolved acquisition metadata onto items that do not already carry an
 * acquisition date (i.e. items sourced from the unenriched global release list).
 * Items keep their original identity when no metadata applies, and the array
 * identity is preserved when nothing changes, so downstream selection effects do
 * not re-run needlessly.
 */
export const overlayAcquisitionMetadata = (
  items: WaybackItemWithMetadata[],
  resolveMetadata: (releaseNum: number) => WaybackMetadata | null | undefined,
): WaybackItemWithMetadata[] => {
  let changed = false;
  const overlaid = items.map((item) => {
    if (item.acquisitionDate) return item;
    const metadata = resolveMetadata(item.releaseNum);
    if (!metadata?.date) return item;
    changed = true;
    return toWaybackItemWithMetadata(item, metadata);
  });
  return changed ? overlaid : items;
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
    if (!existing || item.releaseNum > existing.releaseNum) {
      dateMap.set(dateKey, item);
    }
  });

  return sortWaybackItemsAscending(Array.from(dateMap.values()));
};

export const loadGlobalWaybackItems = async ({
  itemsTimeoutMs = WAYBACK_ITEMS_TIMEOUT_MS,
  getItems = getWaybackItems,
}: Pick<
  LoadWaybackItemsOptions,
  "itemsTimeoutMs" | "getItems"
> = {}): Promise<WaybackItemWithMetadata[]> => {
  const items = await withTimeout(
    getItems(),
    itemsTimeoutMs,
    `Wayback release list timed out after ${itemsTimeoutMs}ms`,
  );

  return dedupeWaybackItems(items.map(toWaybackItemWithoutMetadata));
};

export const loadLocalWaybackItems = async (
  point: WaybackPoint,
  zoomLevel: number,
  {
    itemsTimeoutMs = WAYBACK_ITEMS_TIMEOUT_MS,
    metadataTimeoutMs = WAYBACK_METADATA_TIMEOUT_MS,
    getItemsWithLocalChanges = getWaybackItemsWithLocalChanges,
    getItemMetadata = getMetadata,
    signal,
  }: LoadWaybackItemsOptions = {},
): Promise<WaybackItemWithMetadata[]> => {
  let items: WaybackItem[];

  try {
    items = await withTimeout(
      getItemsWithLocalChanges(point, zoomLevel, {
        signal,
        onlyUseSizeToFilterDuplicates: true,
      }),
      itemsTimeoutMs,
      `Wayback imagery discovery timed out after ${itemsTimeoutMs}ms`,
    );
  } catch (error) {
    console.warn("Failed to load local Wayback imagery", error);
    throw error;
  }

  if (items.length === 0) return [];

  // Attach true acquisition dates so labels/dedupe use when the imagery was
  // captured rather than when ESRI published the release. Enrichment already
  // deduplicates (collapsing releases that share an acquisition date).
  return enrichWaybackItemsWithMetadata(
    items.map(toWaybackItemWithoutMetadata),
    point,
    zoomLevel,
    { metadataTimeoutMs, getItemMetadata, signal },
  );
};

export const loadWaybackMetadata = async (
  point: WaybackPoint,
  zoomLevel: number,
  releaseNum: number,
  {
    metadataTimeoutMs = WAYBACK_METADATA_TIMEOUT_MS,
    getItemMetadata = getMetadata,
  }: Pick<
    LoadWaybackItemsOptions,
    "metadataTimeoutMs" | "getItemMetadata"
  > = {},
): Promise<WaybackMetadata | null> =>
  withTimeout(
    getItemMetadata(point, zoomLevel, releaseNum),
    metadataTimeoutMs,
    `Wayback metadata timed out after ${metadataTimeoutMs}ms for release ${releaseNum}`,
  );

export const loadWaybackItemsWithMetadata = loadLocalWaybackItems;

/**
 * Calculate distance between two coordinates in meters (Haversine formula)
 */
const getDistanceInMeters = (lon1: number, lat1: number, lon2: number, lat2: number): number => {
  const R = 6371000; // Earth's radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Distance threshold for re-fetching (2km - imagery doesn't change much spatially)
const REFETCH_DISTANCE_METERS = 2000;
export const WAYBACK_CANDIDATE_DISCOVERY_ZOOM = 12;
export const WAYBACK_CANDIDATE_DEBOUNCE_MS = 1_000;
export const WAYBACK_CANDIDATE_THROTTLE_MS = 10_000;

/**
 * Hook to fetch Wayback items with actual imagery changes at this location.
 *
 * Pipeline:
 * 1. Fetches the global Wayback release list for immediate, cheap candidates.
 * 2. Optionally refines with local-change candidates after the user asks for it.
 * 3. Deduplicates by release date and sorts ascending (oldest left, newest right).
 *
 * Local refinement only re-fetches when location changes significantly (>2km)
 * and is cached by the coarse Wayback tile key. Zoom changes do not invalidate
 * candidate discovery because the active basemap release should stay stable
 * while the map requests normal tiles for the new view.
 *
 * The global release list is location-independent and therefore only carries
 * release dates, not the imagery's true acquisition date. Change detection is
 * gated behind user interaction, so the global list is what the picker shows by
 * default. To keep the displayed date honest before (and instead of) change
 * detection, we eagerly fetch acquisition metadata for the currently selected
 * release at the map center and merge it in. That is a single, tile-cached
 * request per selection — cheap enough to run ungated, unlike enriching the
 * entire release list.
 */
export const useWaybackItemsDebounced = (
  longitude: number | undefined,
  latitude: number | undefined,
  enabled: boolean = true,
  selectedReleaseNum: number | null = null,
) => {
  // Track the last fetched location
  const lastFetchRef = useRef<{ lon: number; lat: number } | null>(null);
  const lastFetchAtRef = useRef(0);
  const debounceHandleRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const throttleHandleRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const [stableCoords, setStableCoords] = useState<{ lon: number; lat: number } | null>(null);
  const stableTileKey =
    stableCoords !== null
      ? {
          level: WAYBACK_CANDIDATE_DISCOVERY_ZOOM,
          column: long2tile(stableCoords.lon, WAYBACK_CANDIDATE_DISCOVERY_ZOOM),
          row: lat2tile(stableCoords.lat, WAYBACK_CANDIDATE_DISCOVERY_ZOOM),
        }
      : null;

  useEffect(() => {
    if (!enabled || longitude === undefined || latitude === undefined) return;

    const last = lastFetchRef.current;
    const nextCoords = { lon: longitude, lat: latitude };
    const shouldFetch =
      !last ||
      getDistanceInMeters(last.lon, last.lat, longitude, latitude) >
        REFETCH_DISTANCE_METERS;

    if (!shouldFetch) return;

    if (debounceHandleRef.current) {
      globalThis.clearTimeout(debounceHandleRef.current);
    }
    if (throttleHandleRef.current) {
      globalThis.clearTimeout(throttleHandleRef.current);
    }

    const applyNextCoords = () => {
      lastFetchRef.current = nextCoords;
      lastFetchAtRef.current = Date.now();
      setStableCoords(nextCoords);
    };

    debounceHandleRef.current = globalThis.setTimeout(() => {
      const elapsedSinceFetch = Date.now() - lastFetchAtRef.current;
      if (
        lastFetchAtRef.current === 0 ||
        elapsedSinceFetch >= WAYBACK_CANDIDATE_THROTTLE_MS
      ) {
        applyNextCoords();
        return;
      }

      throttleHandleRef.current = globalThis.setTimeout(
        applyNextCoords,
        WAYBACK_CANDIDATE_THROTTLE_MS - elapsedSinceFetch,
      );
    }, WAYBACK_CANDIDATE_DEBOUNCE_MS);

    return () => {
      if (debounceHandleRef.current) {
        globalThis.clearTimeout(debounceHandleRef.current);
        debounceHandleRef.current = null;
      }
      if (throttleHandleRef.current) {
        globalThis.clearTimeout(throttleHandleRef.current);
        throttleHandleRef.current = null;
      }
    };
  }, [longitude, latitude, enabled]);

  const globalItemsQuery = useQuery({
    queryKey: ["wayback-items-global"],
    queryFn: () => loadGlobalWaybackItems(),
    enabled,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
  });

  const localItemsQuery = useQuery({
    queryKey: [
      "wayback-items-local",
      stableTileKey?.level,
      stableTileKey?.column,
      stableTileKey?.row,
    ],
    queryFn: async ({ signal }): Promise<WaybackItemWithMetadata[]> => {
      if (!stableCoords) return [];

      const point = { longitude: stableCoords.lon, latitude: stableCoords.lat };

      return loadLocalWaybackItems(
        point,
        WAYBACK_CANDIDATE_DISCOVERY_ZOOM,
        { signal },
      );
    },
    enabled: enabled && stableCoords !== null,
    staleTime: 30 * 60 * 1000, // Cache for 30 minutes
    gcTime: 60 * 60 * 1000, // Keep in cache for 1 hour
  });

  // Acquisition metadata for the currently selected release at the map center.
  // Keyed by the coarse Wayback tile so nearby views share the cached result.
  // Runs ungated (no dependency on change detection) so the displayed date is
  // the true acquisition date even when only the global release list is loaded.
  const selectedTileColumn =
    longitude !== undefined
      ? long2tile(longitude, WAYBACK_CANDIDATE_DISCOVERY_ZOOM)
      : null;
  const selectedTileRow =
    latitude !== undefined
      ? lat2tile(latitude, WAYBACK_CANDIDATE_DISCOVERY_ZOOM)
      : null;
  const canFetchSelectedMetadata =
    enabled &&
    selectedReleaseNum !== null &&
    selectedTileColumn !== null &&
    selectedTileRow !== null;

  const selectedMetadataQuery = useQuery({
    queryKey: [
      "wayback-selected-metadata",
      selectedReleaseNum,
      selectedTileColumn,
      selectedTileRow,
    ],
    queryFn: () =>
      loadWaybackMetadata(
        { longitude: longitude as number, latitude: latitude as number },
        WAYBACK_CANDIDATE_DISCOVERY_ZOOM,
        selectedReleaseNum as number,
      ),
    enabled: canFetchSelectedMetadata,
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });

  // Accumulate acquisition metadata for every release we have resolved at this
  // tile. Making it sticky (rather than overlaying only the current selection)
  // keeps dates monotonic: navigating never reverts an item to its release
  // date, so auto-match cannot oscillate between items as their true dates are
  // revealed one selection at a time.
  const [metadataByReleaseTile, setMetadataByReleaseTile] = useState<
    Map<string, WaybackMetadata>
  >(new Map());

  useEffect(() => {
    const metadata = selectedMetadataQuery.data;
    if (
      !canFetchSelectedMetadata ||
      selectedReleaseNum === null ||
      !metadata?.date
    ) {
      return;
    }
    const key = `${selectedTileColumn}:${selectedTileRow}:${selectedReleaseNum}`;
    setMetadataByReleaseTile((prev) => {
      if (prev.has(key)) return prev;
      const next = new Map(prev);
      next.set(key, metadata);
      return next;
    });
  }, [
    selectedMetadataQuery.data,
    canFetchSelectedMetadata,
    selectedReleaseNum,
    selectedTileColumn,
    selectedTileRow,
  ]);

  const localItems = localItemsQuery.data ?? [];
  const globalItems = globalItemsQuery.data ?? [];
  const baseItems = localItems.length > 0 ? localItems : globalItems;

  const data = useMemo(() => {
    if (
      metadataByReleaseTile.size === 0 ||
      selectedTileColumn === null ||
      selectedTileRow === null
    ) {
      return baseItems;
    }
    return overlayAcquisitionMetadata(baseItems, (releaseNum) =>
      metadataByReleaseTile.get(
        `${selectedTileColumn}:${selectedTileRow}:${releaseNum}`,
      ),
    );
  }, [baseItems, metadataByReleaseTile, selectedTileColumn, selectedTileRow]);

  return {
    ...globalItemsQuery,
    data,
    isLoading: globalItemsQuery.isLoading && data.length === 0,
    isFetching:
      globalItemsQuery.isFetching ||
      localItemsQuery.isFetching ||
      selectedMetadataQuery.isFetching,
    // Local change-detection in flight: the authoritative, location-specific
    // candidate list is about to replace the global one. Auto-matching should
    // hold off until it lands to avoid switching basemaps twice.
    isRefining: localItemsQuery.isFetching,
    error: localItemsQuery.error ?? globalItemsQuery.error,
  };
};
