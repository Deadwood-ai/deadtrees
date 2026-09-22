import { getDistance } from "ol/sphere";
import parseBBox from "../../utils/parseBBox";
import { formatPriwaReviewDate } from "./priwaReviewPresentation";
import type { IPriwaOfflineMosaic } from "./priwaOfflineMosaics";
import type { IPriwaMatchedMosaic } from "./usePriwaMosaicMatches";
import type { IPriwaMosaic } from "./usePriwaMosaics";

export interface IPriwaFlightListItem {
  mosaic: IPriwaMosaic;
  matchedTreeCount: number;
  isVisible: boolean;
  isPrimary: boolean;
  offlineEntry: IPriwaOfflineMosaic | null;
  /** Rendering is possible right now: online, or a complete offline copy exists. */
  isAvailable: boolean;
}

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

export type PriwaFlightSort = "distance" | "date" | "name";

export const getPriwaFlightDistance = (
  mosaic: IPriwaMosaic,
  center: number[] | null,
) => {
  const bounds = mosaic.bbox ? parseBBox(mosaic.bbox) : null;
  if (!bounds || !center) return Number.POSITIVE_INFINITY;
  // Distance to the closest point of the footprint: flights under the map center come first.
  return getDistance(center, [
    Math.max(bounds[0], Math.min(bounds[2], center[0])),
    Math.max(bounds[1], Math.min(bounds[3], center[1])),
  ]);
};

export const filterPriwaFlightItems = (
  items: IPriwaFlightListItem[],
  query: string,
  sort: PriwaFlightSort,
  center: number[] | null,
) =>
  items
    .filter(({ mosaic }) =>
      `${mosaic.label} ${mosaic.captureDate ?? ""} ${formatPriwaReviewDate(mosaic.captureDate)}`
        .toLocaleLowerCase("de")
        .includes(query.trim().toLocaleLowerCase("de")),
    )
    .sort((a, b) => {
      if (sort === "name")
        return a.mosaic.label.localeCompare(b.mosaic.label, "de", {
          numeric: true,
        });
      if (sort === "distance") {
        const difference =
          getPriwaFlightDistance(a.mosaic, center) -
          getPriwaFlightDistance(b.mosaic, center);
        if (difference && !Number.isNaN(difference)) return difference;
      }
      return compareFlightsByDate(a.mosaic, b.mosaic);
    });

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
