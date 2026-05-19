const FULL_CIRCLE_DEGREES = 360;
const HALF_CIRCLE_DEGREES = 180;

export const MINIMUM_GPS_HEADING_SPEED_MPS = 1.25;

export const normalizeHeading = (heading: number) => {
  const normalized = heading % FULL_CIRCLE_DEGREES;
  return normalized < 0 ? normalized + FULL_CIRCLE_DEGREES : normalized;
};

export const getShortestHeadingDelta = (
  currentHeading: number,
  nextHeading: number,
) => {
  const delta =
    normalizeHeading(nextHeading) - normalizeHeading(currentHeading);

  if (delta > HALF_CIRCLE_DEGREES) {
    return delta - FULL_CIRCLE_DEGREES;
  }

  if (delta < -HALF_CIRCLE_DEGREES) {
    return delta + FULL_CIRCLE_DEGREES;
  }

  return delta;
};

export const smoothHeading = (
  currentHeading: number | null,
  nextHeading: number,
  smoothingFactor: number,
) => {
  if (!Number.isFinite(nextHeading)) return currentHeading;
  if (currentHeading === null || !Number.isFinite(currentHeading)) {
    return normalizeHeading(nextHeading);
  }

  const boundedSmoothingFactor = Math.min(Math.max(smoothingFactor, 0), 1);
  const delta = getShortestHeadingDelta(currentHeading, nextHeading);
  return normalizeHeading(currentHeading + delta * boundedSmoothingFactor);
};

export const shouldUseGpsHeading = (
  heading: number | null,
  speedMetersPerSecond: number | null,
) =>
  typeof heading === "number" &&
  Number.isFinite(heading) &&
  typeof speedMetersPerSecond === "number" &&
  Number.isFinite(speedMetersPerSecond) &&
  speedMetersPerSecond >= MINIMUM_GPS_HEADING_SPEED_MPS;
