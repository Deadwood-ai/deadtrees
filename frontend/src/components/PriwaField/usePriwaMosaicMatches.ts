import { useMemo } from "react";

import { matchPriwaPointsToMosaics } from "./priwaMosaicMatching";
import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";
import type { IPriwaMosaic } from "./usePriwaMosaics";

export interface IPriwaMatchedPoint {
  point: IPriwaPoint;
  daysApart: number;
  source: "confirmed" | "suggestion";
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

const daysBetweenDates = (
  left: string | null | undefined,
  right: string | null | undefined,
) => {
  if (!left || !right) return 0;
  const leftDate = Date.parse(left);
  const rightDate = Date.parse(right);
  if (Number.isNaN(leftDate) || Number.isNaN(rightDate)) return 0;
  return Math.round(Math.abs(leftDate - rightDate) / (24 * 60 * 60 * 1000));
};

export const buildPriwaMosaicMatchIndex = (
  points: IPriwaPoint[],
  mosaics: IPriwaMosaic[],
  groups: IPriwaBefallsgruppe[] = [],
) => {
  const candidates = [...mosaics]
    .filter((mosaic) => mosaic.cogUrl.trim().length > 0)
    .sort(compareMosaics);
  const pointsById = new Map(points.map((point) => [point.id, point]));
  const matchesByMosaicId = new Map<string, IPriwaMatchedPoint[]>();
  const mosaicIdByPointId: Record<string, string> = {};
  const confirmedTreeIds = new Set(groups.flatMap((group) => group.treeIds));

  groups.forEach((group) => {
    group.datasetIds.forEach((datasetId) => {
      const mosaic = candidates.find((candidate) => candidate.id === datasetId);
      if (!mosaic) return;

      group.treeIds.forEach((treeId) => {
        const point = pointsById.get(treeId);
        if (!point) return;
        const mosaicPoints = matchesByMosaicId.get(mosaic.id) ?? [];
        if (
          !mosaicPoints.some(
            ({ point: matchedPoint }) => matchedPoint.id === treeId,
          )
        ) {
          mosaicPoints.push({
            point,
            daysApart: daysBetweenDates(point.datum, mosaic.captureDate),
            source: "confirmed",
          });
          matchesByMosaicId.set(mosaic.id, mosaicPoints);
        }
        mosaicIdByPointId[treeId] ??= mosaic.id;
      });
    });
  });

  const matches = matchPriwaPointsToMosaics(
    points.filter((point) => !confirmedTreeIds.has(point.id)),
    candidates,
  );

  matches.forEach((match) => {
    const point = pointsById.get(match.pointId);
    if (!point) return;

    mosaicIdByPointId[point.id] = match.mosaicId;
    const mosaicPoints = matchesByMosaicId.get(match.mosaicId) ?? [];
    mosaicPoints.push({
      point,
      daysApart: match.daysApart,
      source: "suggestion",
    });
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
  groups: IPriwaBefallsgruppe[] = [],
) =>
  useMemo(
    () => buildPriwaMosaicMatchIndex(points, mosaics, groups),
    [groups, mosaics, points],
  );
