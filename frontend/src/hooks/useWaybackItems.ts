import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getWaybackItemsWithLocalChanges,
  getMetadata,
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
  getItemsWithLocalChanges?: typeof getWaybackItemsWithLocalChanges;
  getItemMetadata?: typeof getMetadata;
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

export const loadWaybackItemsWithMetadata = async (
  point: WaybackPoint,
  zoomLevel: number,
  {
    itemsTimeoutMs = WAYBACK_ITEMS_TIMEOUT_MS,
    metadataTimeoutMs = WAYBACK_METADATA_TIMEOUT_MS,
    getItemsWithLocalChanges = getWaybackItemsWithLocalChanges,
    getItemMetadata = getMetadata,
  }: LoadWaybackItemsOptions = {},
): Promise<WaybackItemWithMetadata[]> => {
  let items: WaybackItem[];

  try {
    items = await withTimeout(
      getItemsWithLocalChanges(point, zoomLevel),
      itemsTimeoutMs,
      `Wayback imagery discovery timed out after ${itemsTimeoutMs}ms`,
    );
  } catch (error) {
    console.warn("Failed to load local Wayback imagery", error);
    throw error;
  }

  if (items.length === 0) return [];

  const itemsWithMetadata = await Promise.all(
    items.map(async (item): Promise<WaybackItemWithMetadata> => {
      try {
        const metadata = await withTimeout(
          getItemMetadata(point, zoomLevel, item.releaseNum),
          metadataTimeoutMs,
          `Wayback metadata timed out after ${metadataTimeoutMs}ms for release ${item.releaseNum}`,
        );
        return toWaybackItemWithMetadata(item, metadata);
      } catch (error) {
        console.warn(
          `Failed to fetch metadata for release ${item.releaseNum}:`,
          error,
        );
        return toWaybackItemWithMetadata(item, undefined);
      }
    }),
  );

  const dateMap = new Map<string, WaybackItemWithMetadata>();
  itemsWithMetadata.forEach((item) => {
    const dateKey =
      item.acquisitionDate?.toISOString() ||
      item.releaseDateLabel ||
      String(item.releaseNum);
    const existing = dateMap.get(dateKey);
    if (!existing || item.releaseNum > existing.releaseNum) {
      dateMap.set(dateKey, item);
    }
  });

  return Array.from(dateMap.values()).sort((a, b) => {
    const dateA = a.acquisitionDate?.getTime() || a.releaseDatetime || 0;
    const dateB = b.acquisitionDate?.getTime() || b.releaseDatetime || 0;
    return dateA - dateB;
  });
};

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
 * 1. Fetches items using getWaybackItemsWithLocalChanges (unique imagery at location)
 * 2. Fetches metadata for ALL items in parallel (acquisition date, provider, source)
 * 3. Deduplicates by acquisition date (same satellite capture = same image)
 * 4. Sorts by acquisition date ascending (oldest left, newest right)
 *
 * Only re-fetches when location changes significantly (>2km). Zoom changes do
 * not invalidate candidate discovery because the active basemap release should
 * stay stable while the map requests normal tiles for the new view.
 */
export const useWaybackItemsDebounced = (
  longitude: number | undefined,
  latitude: number | undefined,
  enabled: boolean = true,
) => {
  // Track the last fetched location
  const lastFetchRef = useRef<{ lon: number; lat: number } | null>(null);
  const lastFetchAtRef = useRef(0);
  const debounceHandleRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const throttleHandleRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const [stableCoords, setStableCoords] = useState<{ lon: number; lat: number } | null>(null);

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

  return useQuery({
    queryKey: [
      "wayback-items-with-metadata",
      stableCoords?.lon,
      stableCoords?.lat,
      WAYBACK_CANDIDATE_DISCOVERY_ZOOM,
    ],
    queryFn: async (): Promise<WaybackItemWithMetadata[]> => {
      if (!stableCoords) return [];

      const point = { longitude: stableCoords.lon, latitude: stableCoords.lat };

      return loadWaybackItemsWithMetadata(
        point,
        WAYBACK_CANDIDATE_DISCOVERY_ZOOM,
      );
    },
    enabled: enabled && stableCoords !== null,
    staleTime: 30 * 60 * 1000, // Cache for 30 minutes
    gcTime: 60 * 60 * 1000, // Keep in cache for 1 hour
  });
};
