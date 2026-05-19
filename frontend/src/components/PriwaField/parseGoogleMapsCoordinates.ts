import type { IPriwaCoordinate } from "./types";

const COORDINATE_PAIR_PATTERN =
  /(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)/;

const GOOGLE_MAPS_AT_PATTERN =
  /@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:,|$)/;

const GOOGLE_MAPS_DATA_PATTERN =
  /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/;

const isValidCoordinate = ({ lat, lon }: IPriwaCoordinate) =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  lat >= -90 &&
  lat <= 90 &&
  lon >= -180 &&
  lon <= 180;

const coordinateFromMatch = (
  match: RegExpMatchArray | null,
): IPriwaCoordinate | null => {
  if (!match) return null;

  const coordinate = {
    lat: Number(match[1]),
    lon: Number(match[2]),
  };

  return isValidCoordinate(coordinate) ? coordinate : null;
};

const parseCoordinatePair = (value: string): IPriwaCoordinate | null =>
  coordinateFromMatch(value.match(COORDINATE_PAIR_PATTERN));

const safelyDecodeUriComponent = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const parseGoogleMapsCoordinates = (
  rawValue: string,
): IPriwaCoordinate | null => {
  const trimmedValue = rawValue.trim();
  if (!trimmedValue) return null;

  const decodedValue = safelyDecodeUriComponent(trimmedValue);

  const dataCoordinate = coordinateFromMatch(
    decodedValue.match(GOOGLE_MAPS_DATA_PATTERN),
  );
  if (dataCoordinate) return dataCoordinate;

  const atCoordinate = coordinateFromMatch(
    decodedValue.match(GOOGLE_MAPS_AT_PATTERN),
  );
  if (atCoordinate) return atCoordinate;

  try {
    const url = new URL(decodedValue);
    const queryCoordinate =
      parseCoordinatePair(url.searchParams.get("query") ?? "") ??
      parseCoordinatePair(url.searchParams.get("q") ?? "") ??
      parseCoordinatePair(url.pathname);

    if (queryCoordinate) return queryCoordinate;
  } catch {
    // Plain coordinate text is valid QR content too.
  }

  return parseCoordinatePair(decodedValue);
};
