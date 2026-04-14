import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getWaybackItemsWithLocalChanges,
  getMetadata,
  type WaybackItem,
  type WaybackMetadata,
} from "@esri/wayback-core";

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
// Zoom threshold for re-fetching
const REFETCH_ZOOM_LEVELS = 3;

/**
 * Hook to fetch Wayback items with actual imagery changes at this location.
 *
 * Pipeline:
 * 1. Fetches items using getWaybackItemsWithLocalChanges (unique imagery at location)
 * 2. Fetches metadata for ALL items in parallel (acquisition date, provider, source)
 * 3. Deduplicates by acquisition date (same satellite capture = same image)
 * 4. Sorts by acquisition date ascending (oldest left, newest right)
 *
 * Only re-fetches when location changes significantly (>2km or >3 zoom levels)
 */
export const useWaybackItemsDebounced = (
  longitude: number | undefined,
  latitude: number | undefined,
  zoom: number | undefined,
  enabled: boolean = true,
) => {
  // Track the last fetched location
  const lastFetchRef = useRef<{ lon: number; lat: number; zoom: number } | null>(null);
  const [stableCoords, setStableCoords] = useState<{ lon: number; lat: number; zoom: number } | null>(null);

  useEffect(() => {
    if (longitude === undefined || latitude === undefined || zoom === undefined) return;

    const last = lastFetchRef.current;
    const shouldFetch =
      !last ||
      getDistanceInMeters(last.lon, last.lat, longitude, latitude) > REFETCH_DISTANCE_METERS ||
      Math.abs(last.zoom - zoom) > REFETCH_ZOOM_LEVELS;

    if (shouldFetch) {
      lastFetchRef.current = { lon: longitude, lat: latitude, zoom };
      setStableCoords({ lon: longitude, lat: latitude, zoom });
    }
  }, [longitude, latitude, zoom]);

  return useQuery({
    queryKey: ["wayback-items-with-metadata", stableCoords?.lon, stableCoords?.lat, stableCoords?.zoom],
    queryFn: async (): Promise<WaybackItemWithMetadata[]> => {
      if (!stableCoords) return [];

      const point = { longitude: stableCoords.lon, latitude: stableCoords.lat };
      const zoomLevel = Math.round(stableCoords.zoom);

      // Step 1: Get items with actual local changes (unique imagery)
      const items = await getWaybackItemsWithLocalChanges(point, zoomLevel);

      if (items.length === 0) return [];

      // Step 2: Fetch metadata for ALL items in parallel
      const metadataPromises = items.map(async (item): Promise<WaybackItemWithMetadata> => {
        try {
          const metadata = await getMetadata(point, zoomLevel, item.releaseNum);
          return {
            ...item,
            metadata,
            acquisitionDate: metadata?.date ? new Date(metadata.date) : undefined,
            provider: metadata?.provider,
            source: metadata?.source,
            resolution: metadata?.resolution,
          };
        } catch (error) {
          console.warn(`Failed to fetch metadata for release ${item.releaseNum}:`, error);
          return { ...item };
        }
      });

      const itemsWithMetadata = await Promise.all(metadataPromises);

      // Step 3: DEDUPLICATE by acquisition date - keep only one item per unique capture date
      // This removes duplicates where same satellite image was re-processed multiple times
      const dateMap = new Map<string, WaybackItemWithMetadata>();
      itemsWithMetadata.forEach((item) => {
        // Use acquisition date as key, or release date as fallback
        const dateKey = item.acquisitionDate?.toISOString() || item.releaseDateLabel || String(item.releaseNum);
        // Keep the item with highest releaseNum (most recent processing) for each date
        const existing = dateMap.get(dateKey);
        if (!existing || item.releaseNum > existing.releaseNum) {
          dateMap.set(dateKey, item);
        }
      });
      const deduplicated = Array.from(dateMap.values());

      // Step 4: Sort by acquisition date ASCENDING (oldest first for left→right navigation)
      const sorted = deduplicated.sort((a, b) => {
        const dateA = a.acquisitionDate?.getTime() || 0;
        const dateB = b.acquisitionDate?.getTime() || 0;
        return dateA - dateB; // Ascending: oldest first (left), newest last (right)
      });

      return sorted;
    },
    enabled: enabled && stableCoords !== null,
    staleTime: 30 * 60 * 1000, // Cache for 30 minutes
    gcTime: 60 * 60 * 1000, // Keep in cache for 1 hour
  });
};
