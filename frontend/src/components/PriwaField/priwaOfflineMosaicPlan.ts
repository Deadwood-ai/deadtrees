import Polygon from "ol/geom/Polygon";
import { getArea } from "ol/sphere";

import parseBBox from "../../utils/parseBBox";
import { resolvePriwaCogUrl } from "./createPriwaCogLayer";
import type { IPriwaMosaic } from "./usePriwaMosaics";

export const PRIWA_OFFLINE_MOSAIC_LIMIT = 2;
export const PRIWA_OFFLINE_MOSAIC_BYTES = 500 * 1024 * 1024;
export const PRIWA_OFFLINE_MOSAIC_AREA_KM2 = 3;

export interface IPriwaOfflineMosaicPlan {
  mosaic: IPriwaMosaic;
  bytes: number;
  areaKm2: number;
  etag: string | null;
  lastModified: string | null;
}

export function priwaMosaicAreaKm2(mosaic: IPriwaMosaic) {
  const bbox = mosaic.bbox && parseBBox(mosaic.bbox);
  if (
    !bbox ||
    bbox.some((value) => !Number.isFinite(value)) ||
    bbox[0] >= bbox[2] ||
    bbox[1] >= bbox[3] ||
    bbox[0] < -180 ||
    bbox[2] > 180 ||
    bbox[1] < -90 ||
    bbox[3] > 90
  ) {
    throw new Error("Die Befliegung hat keine gültige Download-Grenze.");
  }
  const [west, south, east, north] = bbox;
  return (
    getArea(
      new Polygon([
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ]),
      { projection: "EPSG:4326" },
    ) / 1_000_000
  );
}

export function validatePriwaMosaicPackage(plans: IPriwaOfflineMosaicPlan[]) {
  if (
    !plans.length ||
    plans.length > PRIWA_OFFLINE_MOSAIC_LIMIT ||
    new Set(plans.map(({ mosaic }) => mosaic.id)).size !== plans.length
  ) {
    throw new Error(
      "Bitte eine oder zwei unterschiedliche Befliegungen auswählen.",
    );
  }
  if (plans.some(({ bytes }) => !Number.isSafeInteger(bytes) || bytes <= 0)) {
    throw new Error(
      "Die vollständige Dateigröße konnte nicht ermittelt werden.",
    );
  }
  if (
    plans.reduce((sum, plan) => sum + plan.bytes, 0) >
    PRIWA_OFFLINE_MOSAIC_BYTES
  ) {
    throw new Error(
      "Die Auswahl überschreitet 500 MiB. Bitte eine kleinere Befliegung auswählen.",
    );
  }
  if (
    plans.reduce((sum, plan) => sum + plan.areaKm2, 0) >
    PRIWA_OFFLINE_MOSAIC_AREA_KM2
  ) {
    throw new Error(
      "Die vollständigen Befliegungen überschreiten 3 km². Bitte eine kleinere Befliegung auswählen.",
    );
  }
}

export async function planPriwaOfflineMosaics(
  mosaics: IPriwaMosaic[],
  signal?: AbortSignal,
) {
  const plans = await Promise.all(
    mosaics.map(async (mosaic) => {
      const areaKm2 = priwaMosaicAreaKm2(mosaic);
      const response = await fetch(resolvePriwaCogUrl(mosaic.cogUrl), {
        method: "HEAD",
        cache: "no-store",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error(
          `Dateigröße nicht verfügbar (HTTP ${response.status}).`,
        );
      return {
        mosaic,
        areaKm2,
        bytes: Number(response.headers.get("Content-Length")),
        etag: response.headers.get("ETag"),
        lastModified: response.headers.get("Last-Modified"),
      };
    }),
  );
  validatePriwaMosaicPackage(plans);
  return plans;
}
