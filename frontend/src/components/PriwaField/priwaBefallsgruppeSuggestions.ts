import type { IPriwaPoint } from "./types";

export const PRIWA_BEFALLSGRUPPE_MAX_DISTANCE_METERS = 30;
export const PRIWA_BEFALLSGRUPPE_MAX_DATE_DAYS = 7;
export const PRIWA_BEFALLSGRUPPE_ALGORITHM_VERSION = "location-date-v1";

const EARTH_RADIUS_METERS = 6_371_000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export type PriwaBefallsgruppeConfidence = "hoch" | "mittel" | "niedrig";

export interface IPriwaBefallsgruppeSuggestion {
  id: string;
  treeIds: string[];
  confidence: number;
  confidenceLabel: PriwaBefallsgruppeConfidence;
  minDate: string;
  maxDate: string;
  maxDateSpanDays: number;
  maxNeighborDistanceMeters: number;
  reason: string;
  algorithmVersion: string;
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

export const distanceBetweenPriwaPoints = (
  left: IPriwaPoint,
  right: IPriwaPoint,
) => {
  const latitudeDifference = toRadians(right.lat - left.lat);
  const longitudeDifference = toRadians(right.lon - left.lon);
  const leftLatitude = toRadians(left.lat);
  const rightLatitude = toRadians(right.lat);
  const haversine =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(longitudeDifference / 2) ** 2;

  return (
    2 *
    EARTH_RADIUS_METERS *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
};

const dateToUtcDay = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const timestamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  const parsed = new Date(timestamp);
  if (
    Number.isNaN(timestamp) ||
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() !== Number(match[2]) - 1 ||
    parsed.getUTCDate() !== Number(match[3])
  ) {
    return null;
  }
  return Math.floor(timestamp / MILLISECONDS_PER_DAY);
};

const dateDifferenceDays = (left: IPriwaPoint, right: IPriwaPoint) => {
  const leftDay = dateToUtcDay(left.datum);
  const rightDay = dateToUtcDay(right.datum);
  if (leftDay === null || rightDay === null) return Number.POSITIVE_INFINITY;
  return Math.abs(leftDay - rightDay);
};

const confidenceForCluster = (
  maxNeighborDistanceMeters: number,
  maxDateSpanDays: number,
) => {
  const distanceScore = Math.max(
    0,
    1 - maxNeighborDistanceMeters / PRIWA_BEFALLSGRUPPE_MAX_DISTANCE_METERS,
  );
  const dateScore = Math.max(
    0,
    1 - maxDateSpanDays / PRIWA_BEFALLSGRUPPE_MAX_DATE_DAYS,
  );
  return Math.round((0.65 * distanceScore + 0.35 * dateScore) * 100) / 100;
};

const confidenceLabel = (confidence: number): PriwaBefallsgruppeConfidence => {
  if (confidence >= 0.75) return "hoch";
  if (confidence >= 0.45) return "mittel";
  return "niedrig";
};

export const suggestPriwaBefallsgruppen = (
  points: IPriwaPoint[],
  confirmedTreeIds: ReadonlySet<string> = new Set(),
): IPriwaBefallsgruppeSuggestion[] => {
  const candidates = points
    .filter((point) => !confirmedTreeIds.has(point.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const candidateDays = new Map(
    candidates.map((point) => [point.id, dateToUtcDay(point.datum)]),
  );
  const parent = new Map(candidates.map((point) => [point.id, point.id]));
  const minDay = new Map(candidateDays);
  const maxDay = new Map(candidateDays);
  const edges: Array<{ leftId: string; rightId: string; distance: number }> =
    [];

  const findRoot = (treeId: string): string => {
    const currentParent = parent.get(treeId) ?? treeId;
    if (currentParent === treeId) return treeId;
    const root = findRoot(currentParent);
    parent.set(treeId, root);
    return root;
  };
  const mergeRoots = (leftId: string, rightId: string) => {
    const leftRoot = findRoot(leftId);
    const rightRoot = findRoot(rightId);
    if (leftRoot === rightRoot) return;

    const combinedMinDay = Math.min(
      minDay.get(leftRoot) ?? Number.POSITIVE_INFINITY,
      minDay.get(rightRoot) ?? Number.POSITIVE_INFINITY,
    );
    const combinedMaxDay = Math.max(
      maxDay.get(leftRoot) ?? Number.NEGATIVE_INFINITY,
      maxDay.get(rightRoot) ?? Number.NEGATIVE_INFINITY,
    );
    if (
      !Number.isFinite(combinedMinDay) ||
      !Number.isFinite(combinedMaxDay) ||
      combinedMaxDay - combinedMinDay > PRIWA_BEFALLSGRUPPE_MAX_DATE_DAYS
    ) {
      return;
    }

    const [nextRoot, mergedRoot] =
      leftRoot.localeCompare(rightRoot) <= 0
        ? [leftRoot, rightRoot]
        : [rightRoot, leftRoot];
    parent.set(mergedRoot, nextRoot);
    minDay.set(nextRoot, combinedMinDay);
    maxDay.set(nextRoot, combinedMaxDay);
  };

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < candidates.length;
      rightIndex += 1
    ) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      if (dateDifferenceDays(left, right) > PRIWA_BEFALLSGRUPPE_MAX_DATE_DAYS) {
        continue;
      }

      const distance = distanceBetweenPriwaPoints(left, right);
      if (distance > PRIWA_BEFALLSGRUPPE_MAX_DISTANCE_METERS) continue;
      edges.push({ leftId: left.id, rightId: right.id, distance });
    }
  }

  edges
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        left.leftId.localeCompare(right.leftId) ||
        left.rightId.localeCompare(right.rightId),
    )
    .forEach((edge) => mergeRoots(edge.leftId, edge.rightId));

  const pointsById = new Map(candidates.map((point) => [point.id, point]));
  const treeIdsByRoot = new Map<string, string[]>();
  candidates.forEach((candidate) => {
    const root = findRoot(candidate.id);
    const treeIds = treeIdsByRoot.get(root) ?? [];
    treeIds.push(candidate.id);
    treeIdsByRoot.set(root, treeIds);
  });
  const suggestions: IPriwaBefallsgruppeSuggestion[] = [];

  treeIdsByRoot.forEach((treeIds) => {
    if (treeIds.length < 2) return;
    const treeIdSet = new Set(treeIds);
    const maxNeighborDistanceMeters = Math.max(
      0,
      ...edges
        .filter(
          (edge) => treeIdSet.has(edge.leftId) && treeIdSet.has(edge.rightId),
        )
        .map((edge) => edge.distance),
    );
    const clusterPoints = treeIds
      .map((treeId) => pointsById.get(treeId))
      .filter((point): point is IPriwaPoint => !!point);
    const dates = clusterPoints.map((point) => point.datum).sort();
    const dateDays = clusterPoints
      .map((point) => dateToUtcDay(point.datum))
      .filter((day): day is number => day !== null);
    const maxDateSpanDays =
      dateDays.length > 0 ? Math.max(...dateDays) - Math.min(...dateDays) : 0;
    const confidence = confidenceForCluster(
      maxNeighborDistanceMeters,
      maxDateSpanDays,
    );

    suggestions.push({
      id: `suggestion-${treeIds.join("-")}`,
      treeIds: treeIds.sort(),
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      minDate: dates[0],
      maxDate: dates.at(-1) ?? dates[0],
      maxDateSpanDays,
      maxNeighborDistanceMeters: Math.round(maxNeighborDistanceMeters),
      reason: `${treeIds.length} räumlich verbundene Bäume, ${maxDateSpanDays} Tage Datumsabstand, maximal ${Math.round(maxNeighborDistanceMeters)} m zwischen benachbarten Bäumen.`,
      algorithmVersion: PRIWA_BEFALLSGRUPPE_ALGORITHM_VERSION,
    });
  });

  return suggestions.sort((left, right) => {
    const dateDifference = right.maxDate.localeCompare(left.maxDate);
    return dateDifference || right.confidence - left.confidence;
  });
};
