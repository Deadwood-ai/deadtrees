import type { IPriwaOfflineMosaic } from "./priwaOfflineMosaics";
import type { IPriwaMatchedMosaic } from "./usePriwaMosaicMatches";
import type { IPriwaMosaic } from "./usePriwaMosaics";

/** Tablets render at most this many full-resolution orthomosaics at once. */
export const PRIWA_FIELD_MAX_VISIBLE_FLIGHTS = 2;

export interface IPriwaFlightListItem {
  mosaic: IPriwaMosaic;
  matchedTreeCount: number;
  isVisible: boolean;
  isPrimary: boolean;
  offlineEntry: IPriwaOfflineMosaic | null;
  /** Rendering is possible right now: online, or a complete offline copy exists. */
  isAvailable: boolean;
}

export type PriwaFieldFlightIntent = "show" | "compare" | "hide";

const dateRank = (value: string | null | undefined) => {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
};

export const compareFlightsByDate = (left: IPriwaMosaic, right: IPriwaMosaic) =>
  dateRank(right.captureDate) - dateRank(left.captureDate) ||
  dateRank(right.createdAt) - dateRank(left.createdAt) ||
  right.id.localeCompare(left.id, undefined, { numeric: true });

export const isPriwaFieldFlight = (mosaic: IPriwaMosaic) =>
  mosaic.flightType !== "not_priwa" && mosaic.cogUrl.trim().length > 0;

export const buildPriwaFlightListItems = ({
  mosaics,
  matchedMosaics,
  offlineEntries,
  visibleMosaicIds,
  isOnline,
}: {
  mosaics: IPriwaMosaic[];
  matchedMosaics: IPriwaMatchedMosaic[];
  offlineEntries: IPriwaOfflineMosaic[];
  /** Ordered, primary flight first. */
  visibleMosaicIds: string[];
  isOnline: boolean;
}): IPriwaFlightListItem[] => {
  const matchedCounts = new Map(
    matchedMosaics.map(({ mosaic, points }) => [mosaic.id, points.length]),
  );
  const offlineById = new Map(
    offlineEntries.map((entry) => [entry.mosaic.id, entry]),
  );
  return mosaics
    .filter(isPriwaFieldFlight)
    .sort(compareFlightsByDate)
    .map((mosaic) => {
      const offlineEntry = offlineById.get(mosaic.id) ?? null;
      return {
        mosaic,
        matchedTreeCount: matchedCounts.get(mosaic.id) ?? 0,
        isVisible: visibleMosaicIds.includes(mosaic.id),
        isPrimary: visibleMosaicIds[0] === mosaic.id,
        offlineEntry,
        isAvailable: isOnline || !!offlineEntry?.available,
      };
    });
};

/**
 * Resolves which flights stay on the map. The result is ordered with the primary
 * flight first and never exceeds the tablet-safe maximum.
 */
export const resolvePriwaFieldFlightVisibility = (
  visibleMosaicIds: string[],
  mosaicId: string,
  intent: PriwaFieldFlightIntent,
): string[] => {
  const others = visibleMosaicIds.filter((id) => id !== mosaicId);
  if (intent === "hide") return others;
  if (intent === "show") return [mosaicId];
  if (visibleMosaicIds.includes(mosaicId)) return others;
  return [...others.slice(0, PRIWA_FIELD_MAX_VISIBLE_FLIGHTS - 1), mosaicId];
};

/**
 * Which remembered flight to restore once the project's flights (online or
 * cached) are known. Nothing is restored while the forester already chose one.
 */
export const resolvePriwaFieldFlightRestore = ({
  persistedMosaicId,
  availableMosaicIds,
  hasVisibleFlights,
  isOnline,
}: {
  persistedMosaicId: string | null;
  availableMosaicIds: string[];
  hasVisibleFlights: boolean;
  isOnline: boolean;
}) => {
  if (hasVisibleFlights) return null;
  if (persistedMosaicId && availableMosaicIds.includes(persistedMosaicId)) {
    return persistedMosaicId;
  }
  return isOnline ? null : (availableMosaicIds[0] ?? null);
};

/**
 * The initial "fit to trees" waits while a remembered flight may still be
 * restored, so an offline restart opens on the saved orthomosaic instead of a
 * distant tree cluster.
 */
export const shouldDeferPriwaInitialPointsFit = ({
  hasPersistedFlight,
  hasAttemptedRestore,
  isLoadingFlights,
}: {
  hasPersistedFlight: boolean;
  hasAttemptedRestore: boolean;
  isLoadingFlights: boolean;
}) => hasPersistedFlight && !hasAttemptedRestore && isLoadingFlights;

export const orderPriwaVisibleFlights = (
  enabledMosaicIds: ReadonlySet<string>,
  selectedMosaicId: string | null,
) => [
  ...(selectedMosaicId && enabledMosaicIds.has(selectedMosaicId)
    ? [selectedMosaicId]
    : []),
  ...Array.from(enabledMosaicIds).filter((id) => id !== selectedMosaicId),
];

const MEBIBYTE = 1024 * 1024;

export const formatPriwaMebibytes = (bytes: number) => {
  const mebibytes = bytes / MEBIBYTE;
  return `${mebibytes.toLocaleString("de-DE", {
    maximumFractionDigits: mebibytes < 10 ? 1 : 0,
  })} MiB`;
};

export const formatPriwaAreaKm2 = (areaKm2: number) =>
  `${areaKm2.toLocaleString("de-DE", {
    minimumFractionDigits: areaKm2 < 10 ? 1 : 0,
    maximumFractionDigits: areaKm2 < 1 ? 2 : 1,
  })} km²`;

export const formatPriwaFlightAuthors = (authors: string[]) =>
  authors.filter((author) => author.trim()).join(", ");
