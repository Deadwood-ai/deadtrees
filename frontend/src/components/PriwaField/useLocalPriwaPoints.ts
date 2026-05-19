import { useCallback, useEffect, useState } from "react";

import type { IPriwaPoint } from "./types";

const STORAGE_KEY = "deadtrees-priwa-field-points-v1";

const today = () => new Date().toISOString().slice(0, 10);

const normalizePoint = (value: unknown): IPriwaPoint | null => {
  if (!value || typeof value !== "object") return null;
  const point = value as Partial<IPriwaPoint>;
  const legacyPoint = value as Partial<IPriwaPoint> & {
    status?: string;
    note?: string;
  };

  if (
    typeof point.id !== "string" ||
    typeof point.lat !== "number" ||
    typeof point.lon !== "number"
  ) {
    return null;
  }

  return {
    id: point.id,
    lat: point.lat,
    lon: point.lon,
    baumnr: typeof point.baumnr === "string" ? point.baumnr : "",
    fund:
      point.fund ??
      (legacyPoint.status === "checked_empty"
        ? "nein"
        : legacyPoint.status === "unclear"
          ? "unsicher"
          : "ja"),
    baumart: point.baumart ?? "Fichte",
    bm: point.bm ?? "nein",
    bohrloch: point.bohrloch ?? "nein",
    harz: point.harz ?? "nein",
    nadel: point.nadel ?? "grün",
    rinde: point.rinde ?? "0%",
    kv: point.kv ?? "0%",
    name: point.name ?? "andere",
    datum: point.datum ?? point.capturedAt?.slice(0, 10) ?? today(),
    kom: typeof point.kom === "string" ? point.kom : (legacyPoint.note ?? ""),
    capturedAt: point.capturedAt ?? new Date().toISOString(),
    coordinateSource: point.coordinateSource ?? "qr",
    gps: point.gps ?? "ja",
    isEstimatedLocation: point.isEstimatedLocation ?? point.gps === "nein",
    bhd: point.bhd ?? null,
    grueneNadeln: point.grueneNadeln ?? null,
    andererSchaden: point.andererSchaden ?? false,
    fotoQrName: point.fotoQrName,
    rawQrValue: point.rawQrValue,
  };
};

const loadStoredPoints = (): IPriwaPoint[] => {
  if (typeof window === "undefined") return [];

  try {
    const storedValue = window.localStorage.getItem(STORAGE_KEY);
    if (!storedValue) return [];

    const parsedValue = JSON.parse(storedValue);
    if (!Array.isArray(parsedValue)) return [];

    return parsedValue
      .map((storedPoint) => normalizePoint(storedPoint))
      .filter((point): point is IPriwaPoint => point !== null);
  } catch {
    return [];
  }
};

export const useLocalPriwaPoints = () => {
  const [points, setPoints] = useState<IPriwaPoint[]>(loadStoredPoints);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(points));
  }, [points]);

  const addPoint = useCallback((point: IPriwaPoint) => {
    setPoints((currentPoints) => [point, ...currentPoints]);
  }, []);

  const deletePoint = useCallback((pointId: string) => {
    setPoints((currentPoints) =>
      currentPoints.filter((point) => point.id !== pointId),
    );
  }, []);

  const updatePoint = useCallback((point: IPriwaPoint) => {
    setPoints((currentPoints) =>
      currentPoints.map((currentPoint) =>
        currentPoint.id === point.id ? point : currentPoint,
      ),
    );
  }, []);

  return { points, addPoint, updatePoint, deletePoint };
};
