export type PriwaMapExtent = [number, number, number, number];

export const PRIWA_OFFLINE_READY_COVERAGE_RATIO = 0.8;

const intersectExtents = (
  viewport: PriwaMapExtent,
  extent: PriwaMapExtent,
): PriwaMapExtent | null => {
  const intersection: PriwaMapExtent = [
    Math.max(viewport[0], extent[0]),
    Math.max(viewport[1], extent[1]),
    Math.min(viewport[2], extent[2]),
    Math.min(viewport[3], extent[3]),
  ];

  return intersection[0] < intersection[2] && intersection[1] < intersection[3]
    ? intersection
    : null;
};

const mergedIntervalLength = (intervals: Array<[number, number]>) => {
  const sortedIntervals = [...intervals].sort(
    (left, right) => left[0] - right[0],
  );
  let coveredLength = 0;
  let currentStart: number | null = null;
  let currentEnd: number | null = null;

  for (const [start, end] of sortedIntervals) {
    if (currentStart === null || currentEnd === null) {
      currentStart = start;
      currentEnd = end;
      continue;
    }
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
      continue;
    }
    coveredLength += currentEnd - currentStart;
    currentStart = start;
    currentEnd = end;
  }

  return currentStart === null || currentEnd === null
    ? coveredLength
    : coveredLength + currentEnd - currentStart;
};

export const calculatePriwaOfflineCoverageRatio = (
  viewport: PriwaMapExtent | null,
  downloadedExtents: PriwaMapExtent[],
) => {
  if (!viewport) return 0;
  const viewportArea =
    (viewport[2] - viewport[0]) * (viewport[3] - viewport[1]);
  if (viewportArea <= 0) return 0;

  const intersections = downloadedExtents
    .map((extent) => intersectExtents(viewport, extent))
    .filter((extent): extent is PriwaMapExtent => extent !== null);
  if (intersections.length === 0) return 0;

  const xCoordinates = Array.from(
    new Set(intersections.flatMap((extent) => [extent[0], extent[2]])),
  ).sort((left, right) => left - right);
  let coveredArea = 0;

  for (let index = 0; index < xCoordinates.length - 1; index += 1) {
    const minX = xCoordinates[index];
    const maxX = xCoordinates[index + 1];
    const yIntervals = intersections
      .filter((extent) => extent[0] < maxX && extent[2] > minX)
      .map((extent): [number, number] => [extent[1], extent[3]]);
    coveredArea += (maxX - minX) * mergedIntervalLength(yIntervals);
  }

  return Math.min(1, coveredArea / viewportArea);
};
