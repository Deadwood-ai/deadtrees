import parseBBox from "../../utils/parseBBox";

import type { IPriwaPoint } from "./types";
import type { IPriwaMosaic } from "./usePriwaMosaics";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export const PRIWA_MOSAIC_MATCH_MAX_DAYS = 30;

export interface IPriwaPointMosaicMatch {
  pointId: string;
  mosaicId: string;
  daysApart: number;
}

export type PriwaMosaicUnmatchedReasonCode =
  | "missing-footprint"
  | "missing-capture-date"
  | "no-trees-in-footprint"
  | "no-trees-in-date-window"
  | "closer-flight-selected";

export interface IPriwaMosaicUnmatchedReason {
  reasonCode: PriwaMosaicUnmatchedReasonCode;
  reason: string;
}

interface IPriwaMosaicCandidate {
  mosaic: IPriwaMosaic;
  captureDay: number;
  daysApart: number;
}

const dateOnlyToUtcDay = (value: string | null | undefined) => {
  if (!value) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return Math.floor(timestamp / MILLISECONDS_PER_DAY);
};

const compareCandidates = (
  left: IPriwaMosaicCandidate,
  right: IPriwaMosaicCandidate,
) => {
  const dayDifference = left.daysApart - right.daysApart;
  if (dayDifference !== 0) return dayDifference;

  const captureDifference = right.captureDay - left.captureDay;
  if (captureDifference !== 0) return captureDifference;

  const uploadDifference =
    Date.parse(right.mosaic.createdAt) - Date.parse(left.mosaic.createdAt);
  if (!Number.isNaN(uploadDifference) && uploadDifference !== 0) {
    return uploadDifference;
  }

  return right.mosaic.id.localeCompare(left.mosaic.id, undefined, {
    numeric: true,
  });
};

const pointIsInsideMosaic = (point: IPriwaPoint, mosaic: IPriwaMosaic) => {
  if (
    !mosaic.bbox ||
    !Number.isFinite(point.lon) ||
    !Number.isFinite(point.lat)
  ) {
    return false;
  }

  const bbox = parseBBox(mosaic.bbox);
  if (!bbox) return false;

  const [minLon, minLat, maxLon, maxLat] = bbox;
  return (
    point.lon >= minLon &&
    point.lon <= maxLon &&
    point.lat >= minLat &&
    point.lat <= maxLat
  );
};

export const explainUnmatchedPriwaMosaic = (
  points: IPriwaPoint[],
  mosaic: IPriwaMosaic,
  maxDaysApart = PRIWA_MOSAIC_MATCH_MAX_DAYS,
): IPriwaMosaicUnmatchedReason => {
  if (!mosaic.bbox || !parseBBox(mosaic.bbox)) {
    return {
      reasonCode: "missing-footprint",
      reason: "Die Kartengrenze der Befliegung fehlt oder ist ungültig.",
    };
  }

  const captureDay = dateOnlyToUtcDay(mosaic.captureDate);
  if (captureDay === null) {
    return {
      reasonCode: "missing-capture-date",
      reason: "Das Aufnahmedatum der Befliegung fehlt oder ist ungültig.",
    };
  }

  const pointsInFootprint = points.filter((point) =>
    pointIsInsideMosaic(point, mosaic),
  );
  if (pointsInFootprint.length === 0) {
    return {
      reasonCode: "no-trees-in-footprint",
      reason: "Keine Käferbäume liegen innerhalb der Kartengrenze.",
    };
  }

  const normalizedMaxDays = Math.max(0, Math.floor(maxDaysApart));
  const hasPointInDateWindow = pointsInFootprint.some((point) => {
    const pointDay = dateOnlyToUtcDay(point.datum);
    return (
      pointDay !== null && Math.abs(captureDay - pointDay) <= normalizedMaxDays
    );
  });
  if (!hasPointInDateWindow) {
    return {
      reasonCode: "no-trees-in-date-window",
      reason: `Die Bäume in der Kartengrenze liegen mehr als ${normalizedMaxDays} Tage vom Flugdatum entfernt.`,
    };
  }

  return {
    reasonCode: "closer-flight-selected",
    reason:
      "Passende Käferbäume wurden einer zeitlich näheren Befliegung vorgeschlagen.",
  };
};

export const matchPriwaPointsToMosaics = (
  points: IPriwaPoint[],
  mosaics: IPriwaMosaic[],
  maxDaysApart = PRIWA_MOSAIC_MATCH_MAX_DAYS,
): IPriwaPointMosaicMatch[] => {
  const normalizedMaxDays = Math.max(0, Math.floor(maxDaysApart));

  return points.flatMap((point) => {
    const pointDay = dateOnlyToUtcDay(point.datum);
    if (pointDay === null) return [];

    const candidates = mosaics.flatMap<IPriwaMosaicCandidate>((mosaic) => {
      if (!pointIsInsideMosaic(point, mosaic)) return [];

      const captureDay = dateOnlyToUtcDay(mosaic.captureDate);
      if (captureDay === null) return [];

      const daysApart = Math.abs(captureDay - pointDay);
      if (daysApart > normalizedMaxDays) return [];

      return [{ mosaic, captureDay, daysApart }];
    });

    const bestCandidate = candidates.sort(compareCandidates)[0];
    if (!bestCandidate) return [];

    return [
      {
        pointId: point.id,
        mosaicId: bestCandidate.mosaic.id,
        daysApart: bestCandidate.daysApart,
      },
    ];
  });
};
