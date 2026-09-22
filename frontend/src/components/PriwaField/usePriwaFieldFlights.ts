import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildPriwaFlightListItems,
  orderPriwaVisibleFlights,
  resolvePriwaFieldFlightRestore,
  resolvePriwaFieldFlightVisibility,
  shouldDeferPriwaInitialPointsFit,
  type PriwaFieldFlightIntent,
} from "./priwaFieldFlights";
import type { IPriwaOfflineMosaic } from "./priwaOfflineMosaics";
import type { IPriwaMatchedMosaic } from "./usePriwaMosaicMatches";
import type { IPriwaMosaic } from "./usePriwaMosaics";

interface UsePriwaFieldFlightsOptions {
  projectId: string;
  /** Only the touch-first field layout drives flight visibility this way. */
  enabled: boolean;
  mosaics: IPriwaMosaic[];
  matchedMosaics: IPriwaMatchedMosaic[];
  reviewMosaics: IPriwaMosaic[];
  enabledMosaicIds: ReadonlySet<string>;
  selectedMosaicId: string | null;
  showOnlyMosaics: (mosaicIds: string[]) => void;
  offlineEntries: IPriwaOfflineMosaic[];
  isOnline: boolean;
  isLoading: boolean;
  /** Called once per project when the remembered flight comes back on the map. */
  onRestore?: (mosaic: IPriwaMosaic) => void;
}

const flightStorageKey = (projectId: string) =>
  `deadtrees-priwa-field:flight:${projectId}`;

const readPersistedFlightId = (projectId: string) => {
  try {
    return window.localStorage.getItem(flightStorageKey(projectId));
  } catch {
    return null;
  }
};

const persistFlightId = (projectId: string, mosaicId: string | null) => {
  try {
    if (mosaicId) {
      window.localStorage.setItem(flightStorageKey(projectId), mosaicId);
    } else {
      window.localStorage.removeItem(flightStorageKey(projectId));
    }
  } catch {
    // Remembering the flight is a convenience; private browsing may disable it.
  }
};

export function usePriwaFieldFlights({
  projectId,
  enabled,
  mosaics,
  matchedMosaics,
  reviewMosaics,
  enabledMosaicIds,
  selectedMosaicId,
  showOnlyMosaics,
  offlineEntries,
  isOnline,
  isLoading,
  onRestore,
}: UsePriwaFieldFlightsOptions) {
  const hasRestoredRef = useRef(false);
  const [restoreAttemptedFor, setRestoreAttemptedFor] = useState<string | null>(
    null,
  );
  const hasPersistedFlight = useMemo(
    () => !!readPersistedFlightId(projectId),
    [projectId],
  );
  const visibleMosaicIds = useMemo(
    () => orderPriwaVisibleFlights(enabledMosaicIds, selectedMosaicId),
    [enabledMosaicIds, selectedMosaicId],
  );
  const items = useMemo(
    () =>
      buildPriwaFlightListItems({
        mosaics,
        matchedMosaics,
        offlineEntries,
        visibleMosaicIds,
        isOnline,
      }),
    [isOnline, matchedMosaics, mosaics, offlineEntries, visibleMosaicIds],
  );
  const visibleFlights = useMemo(
    () =>
      visibleMosaicIds.flatMap((mosaicId) => {
        const item = items.find(
          (candidate) => candidate.mosaic.id === mosaicId,
        );
        return item ? [item.mosaic] : [];
      }),
    [items, visibleMosaicIds],
  );
  const primaryFlight = visibleFlights[0] ?? null;

  useEffect(() => {
    hasRestoredRef.current = false;
  }, [projectId]);

  useEffect(() => {
    if (!enabled || isLoading || hasRestoredRef.current) return;
    if (reviewMosaics.length === 0) return;
    hasRestoredRef.current = true;
    setRestoreAttemptedFor(projectId);
    const restoredId = resolvePriwaFieldFlightRestore({
      persistedMosaicId: readPersistedFlightId(projectId),
      availableMosaicIds: items
        .filter((item) => item.isAvailable)
        .map((item) => item.mosaic.id),
      hasVisibleFlights: enabledMosaicIds.size > 0,
      isOnline,
    });
    const restored = reviewMosaics.find((mosaic) => mosaic.id === restoredId);
    if (!restored) return;
    showOnlyMosaics([restored.id]);
    onRestore?.(restored);
  }, [
    enabled,
    enabledMosaicIds.size,
    isLoading,
    isOnline,
    items,
    onRestore,
    projectId,
    reviewMosaics,
    showOnlyMosaics,
  ]);

  useEffect(() => {
    if (!enabled || !hasRestoredRef.current) return;
    persistFlightId(projectId, primaryFlight?.id ?? null);
  }, [enabled, primaryFlight?.id, projectId]);

  const applyIntent = useCallback(
    (mosaicId: string, intent: PriwaFieldFlightIntent) => {
      showOnlyMosaics(
        resolvePriwaFieldFlightVisibility(visibleMosaicIds, mosaicId, intent),
      );
    },
    [showOnlyMosaics, visibleMosaicIds],
  );

  return {
    items,
    visibleMosaicIds,
    visibleFlights,
    primaryFlight,
    isAwaitingRestore:
      enabled &&
      shouldDeferPriwaInitialPointsFit({
        hasPersistedFlight,
        hasAttemptedRestore: restoreAttemptedFor === projectId,
        isLoadingFlights: isLoading,
      }),
    showFlight: useCallback(
      (mosaicId: string) => applyIntent(mosaicId, "show"),
      [applyIntent],
    ),
    compareFlight: useCallback(
      (mosaicId: string) => applyIntent(mosaicId, "compare"),
      [applyIntent],
    ),
    hideFlight: useCallback(
      (mosaicId: string) => applyIntent(mosaicId, "hide"),
      [applyIntent],
    ),
    hideAllFlights: useCallback(() => showOnlyMosaics([]), [showOnlyMosaics]),
  };
}

export type PriwaFieldFlightsState = ReturnType<typeof usePriwaFieldFlights>;
