import { useMemo } from "react";

import { matchPriwaPointsToMosaics } from "./priwaMosaicMatching";
import type { IPriwaPoint } from "./types";
import type { IPriwaMosaic } from "./usePriwaMosaics";

export interface IPriwaMatchedPoint {
  point: IPriwaPoint;
  daysApart: number;
}

export interface IPriwaMatchedMosaic {
  mosaic: IPriwaMosaic;
  points: IPriwaMatchedPoint[];
  minDaysApart: number;
  maxDaysApart: number;
}

const dateRank = (value: string | null | undefined) => {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
};

const compareMosaics = (left: IPriwaMosaic, right: IPriwaMosaic) => {
  const captureDifference =
    dateRank(right.captureDate) - dateRank(left.captureDate);
  if (captureDifference !== 0) return captureDifference;

  const uploadDifference = dateRank(right.createdAt) - dateRank(left.createdAt);
  if (uploadDifference !== 0) return uploadDifference;

  return right.id.localeCompare(left.id, undefined, { numeric: true });
};

const compareMatchedPoints = (
  left: IPriwaMatchedPoint,
  right: IPriwaMatchedPoint,
) => {
  const dateDifference =
    dateRank(right.point.datum) - dateRank(left.point.datum);
  if (dateDifference !== 0) return dateDifference;

  return left.point.baumnr.localeCompare(right.point.baumnr, "de", {
    numeric: true,
  });
};

export const buildPriwaMosaicMatchIndex = (
  points: IPriwaPoint[],
  mosaics: IPriwaMosaic[],
) => {
  const candidates = [...mosaics]
    .filter((mosaic) => mosaic.cogUrl.trim().length > 0)
    .sort(compareMosaics);
  const matches = matchPriwaPointsToMosaics(points, candidates);
  const pointsById = new Map(points.map((point) => [point.id, point]));
  const matchesByMosaicId = new Map<string, IPriwaMatchedPoint[]>();
  const mosaicIdByPointId: Record<string, string> = {};

  matches.forEach((match) => {
    const point = pointsById.get(match.pointId);
    if (!point) return;

    mosaicIdByPointId[point.id] = match.mosaicId;
    const mosaicPoints = matchesByMosaicId.get(match.mosaicId) ?? [];
    mosaicPoints.push({ point, daysApart: match.daysApart });
    matchesByMosaicId.set(match.mosaicId, mosaicPoints);
  });

  const matchedMosaics = candidates.flatMap<IPriwaMatchedMosaic>((mosaic) => {
    const matchedPoints = matchesByMosaicId.get(mosaic.id);
    if (!matchedPoints?.length) return [];

    matchedPoints.sort(compareMatchedPoints);
    const dayDistances = matchedPoints.map(({ daysApart }) => daysApart);
    return [
      {
        mosaic,
        points: matchedPoints,
        minDaysApart: Math.min(...dayDistances),
        maxDaysApart: Math.max(...dayDistances),
      },
    ];
  });

  return {
    candidateCount: candidates.length,
    matchedMosaics,
    mosaicIdByPointId,
  };
};

export const usePriwaMosaicMatches = (
  points: IPriwaPoint[],
  mosaics: IPriwaMosaic[],
) =>
  useMemo(() => buildPriwaMosaicMatchIndex(points, mosaics), [mosaics, points]);
