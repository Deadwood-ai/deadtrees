import { fromExtent } from "ol/geom/Polygon";
import { getArea as getGeodesicArea } from "ol/sphere";

import {
  LGL_DOP20_FORMAT,
  LGL_DOP20_LAYER,
  LGL_DOP20_MATRIX_SET,
  LGL_DOP20_STYLE,
  LGL_DOP20_WMTS_URL,
} from "./createLglDop20Layer";
import {
  PRIWA_TOPOGRAPHIC_MAX_ZOOM,
  PRIWA_TOPOGRAPHIC_TILE_URL_PREFIX,
} from "./createPriwaTopographicLayer";

export const PRIWA_BASEMAP_CACHE_PREFIX = "deadtrees-priwa-basemap-v1";
export const PRIWA_BASEMAP_MIN_ZOOM = 16;
export const PRIWA_BASEMAP_MAX_ZOOM = 20;
export const PRIWA_BASEMAP_MAX_TILES = 9_000;
export const PRIWA_BASEMAP_MAX_AREA_KM2 = 3;
export const PRIWA_BASEMAP_SELECTION_INSET_RATIO = 0.08;
export const PRIWA_BASEMAP_SELECTION_MAX_HEIGHT_RATIO = 0.58;
export const PRIWA_BASEMAP_CACHE_CONCURRENCY = 8;

const WEB_MERCATOR_HALF_WORLD = 20037508.342789244;

export interface IPriwaBasemapTilePlan {
  extent3857: [number, number, number, number];
  areaKm2: number;
  minZoom: number;
  maxZoom: number;
  tileCount: number;
  urls: string[];
}

export interface IPriwaBasemapCacheProgress {
  cached: number;
  failed: number;
  total: number;
}

export interface IPriwaBasemapCacheResult {
  cached: number;
  failed: number;
}

export type PriwaBasemapProgressHandler = (
  progress: IPriwaBasemapCacheProgress,
) => void;

interface IPriwaBasemapTileRange {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const tileSpanForZoom = (zoom: number) =>
  (WEB_MERCATOR_HALF_WORLD * 2) / 2 ** zoom;

const appendWmtsParams = (url: string, params: Record<string, string>) => {
  const queryString = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

  return `${url.replace(/[?&]$/, "")}${url.includes("?") ? "&" : "?"}${queryString}`;
};

export const getPriwaBasemapSelectionExtent = (
  extent3857: [number, number, number, number],
  insetRatio = PRIWA_BASEMAP_SELECTION_INSET_RATIO,
): [number, number, number, number] => {
  const [minX, minY, maxX, maxY] = extent3857;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const sideLength = Math.min(
    Math.abs(maxX - minX) * (1 - insetRatio * 2),
    Math.abs(maxY - minY) * PRIWA_BASEMAP_SELECTION_MAX_HEIGHT_RATIO,
  );
  const halfSideLength = sideLength / 2;

  return [
    clamp(
      centerX - halfSideLength,
      -WEB_MERCATOR_HALF_WORLD,
      WEB_MERCATOR_HALF_WORLD,
    ),
    clamp(
      centerY - halfSideLength,
      -WEB_MERCATOR_HALF_WORLD,
      WEB_MERCATOR_HALF_WORLD,
    ),
    clamp(
      centerX + halfSideLength,
      -WEB_MERCATOR_HALF_WORLD,
      WEB_MERCATOR_HALF_WORLD,
    ),
    clamp(
      centerY + halfSideLength,
      -WEB_MERCATOR_HALF_WORLD,
      WEB_MERCATOR_HALF_WORLD,
    ),
  ];
};

const calculateGeodesicAreaKm2 = (
  extent3857: [number, number, number, number],
) =>
  getGeodesicArea(fromExtent(extent3857), { projection: "EPSG:3857" }) /
  1_000_000;

const tileRangeForExtent = (
  extent3857: [number, number, number, number],
  zoom: number,
): IPriwaBasemapTileRange => {
  const tileSpan = tileSpanForZoom(zoom);
  const [minX, minY, maxX, maxY] = extent3857;
  const maxTile = 2 ** zoom - 1;

  return {
    minCol: clamp(
      Math.floor((minX + WEB_MERCATOR_HALF_WORLD) / tileSpan),
      0,
      maxTile,
    ),
    maxCol: clamp(
      Math.ceil((maxX + WEB_MERCATOR_HALF_WORLD) / tileSpan) - 1,
      0,
      maxTile,
    ),
    minRow: clamp(
      Math.floor((WEB_MERCATOR_HALF_WORLD - maxY) / tileSpan),
      0,
      maxTile,
    ),
    maxRow: clamp(
      Math.ceil((WEB_MERCATOR_HALF_WORLD - minY) / tileSpan) - 1,
      0,
      maxTile,
    ),
  };
};

const countTilesInRange = (range: IPriwaBasemapTileRange) =>
  (range.maxCol - range.minCol + 1) * (range.maxRow - range.minRow + 1);

export const getPriwaBasemapCacheName = (projectId: string) =>
  `${PRIWA_BASEMAP_CACHE_PREFIX}-${encodeURIComponent(projectId)}`;

export const createPriwaBasemapTileUrl = ({
  zoom,
  row,
  col,
}: {
  zoom: number;
  row: number;
  col: number;
}) => {
  const baseUrl = appendWmtsParams(LGL_DOP20_WMTS_URL, {
    layer: LGL_DOP20_LAYER,
    style: LGL_DOP20_STYLE,
    tilematrixset: LGL_DOP20_MATRIX_SET,
    Service: "WMTS",
    Request: "GetTile",
    Version: "1.0.0",
    Format: LGL_DOP20_FORMAT,
  });

  return appendWmtsParams(baseUrl, {
    TileMatrix: `${LGL_DOP20_MATRIX_SET}:${zoom}`,
    TileCol: String(col),
    TileRow: String(row),
  });
};

export const createPriwaTopographicTileUrl = ({
  zoom,
  row,
  col,
}: {
  zoom: number;
  row: number;
  col: number;
}) => `${PRIWA_TOPOGRAPHIC_TILE_URL_PREFIX}/${zoom}/${row}/${col}.png`;

export const buildPriwaBasemapTilePlan = (
  selectedExtent3857: [number, number, number, number],
): IPriwaBasemapTilePlan => {
  const extent3857 = selectedExtent3857;
  const minZoom = PRIWA_BASEMAP_MIN_ZOOM;
  const maxZoom = PRIWA_BASEMAP_MAX_ZOOM;
  const ranges: Array<{ zoom: number; range: IPriwaBasemapTileRange }> = [];
  let tileCount = 0;

  for (let tileZoom = minZoom; tileZoom <= maxZoom; tileZoom += 1) {
    const range = tileRangeForExtent(extent3857, tileZoom);
    ranges.push({ zoom: tileZoom, range });
    const tileCountForZoom = countTilesInRange(range);
    tileCount += tileCountForZoom;
    if (tileZoom <= PRIWA_TOPOGRAPHIC_MAX_ZOOM) {
      tileCount += tileCountForZoom;
    }
  }

  const areaKm2 = calculateGeodesicAreaKm2(extent3857);
  const urls: string[] = [];

  if (
    areaKm2 <= PRIWA_BASEMAP_MAX_AREA_KM2 &&
    tileCount <= PRIWA_BASEMAP_MAX_TILES &&
    tileCount > 0
  ) {
    for (const { zoom: tileZoom, range } of ranges) {
      for (let row = range.minRow; row <= range.maxRow; row += 1) {
        for (let col = range.minCol; col <= range.maxCol; col += 1) {
          urls.push(createPriwaBasemapTileUrl({ zoom: tileZoom, row, col }));
          if (tileZoom <= PRIWA_TOPOGRAPHIC_MAX_ZOOM) {
            urls.push(
              createPriwaTopographicTileUrl({ zoom: tileZoom, row, col }),
            );
          }
        }
      }
    }
  }

  return {
    extent3857,
    areaKm2,
    minZoom,
    maxZoom,
    tileCount,
    urls,
  };
};

export const validatePriwaBasemapTilePlan = (plan: IPriwaBasemapTilePlan) => {
  if (plan.areaKm2 > PRIWA_BASEMAP_MAX_AREA_KM2) {
    throw new Error(
      `Der Ausschnitt ist zu groß (${plan.areaKm2.toFixed(2)} km²). Bitte näher heranzoomen oder einen kleineren Bereich wählen.`,
    );
  }

  if (plan.tileCount > PRIWA_BASEMAP_MAX_TILES) {
    throw new Error(
      `Der Ausschnitt enthält zu viele Basiskarten-Kacheln (${plan.tileCount}). Bitte näher heranzoomen oder einen kleineren Bereich wählen.`,
    );
  }

  if (plan.tileCount === 0) {
    throw new Error(
      "Für diesen Ausschnitt wurden keine Basiskarten-Kacheln gefunden.",
    );
  }
};

export const cachePriwaBasemapTiles = async (
  projectId: string,
  urls: string[],
  onProgress?: PriwaBasemapProgressHandler,
): Promise<IPriwaBasemapCacheResult> => {
  if (!("caches" in globalThis)) {
    throw new Error(
      "Offline-Kartenspeicher wird von diesem Browser nicht unterstützt.",
    );
  }

  const cache = await globalThis.caches.open(
    getPriwaBasemapCacheName(projectId),
  );
  let cached = 0;
  let failed = 0;
  let nextUrlIndex = 0;

  const cacheNextTile = async () => {
    while (nextUrlIndex < urls.length) {
      const url = urls[nextUrlIndex];
      nextUrlIndex += 1;

      try {
        const request = new Request(url, {
          cache: "reload",
          mode: "no-cors",
        });
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
          cached += 1;
          onProgress?.({ cached, failed, total: urls.length });
          continue;
        }

        const response = await fetch(request);
        if (!response.ok && response.type !== "opaque") {
          throw new Error(`Tile request failed with ${response.status}`);
        }

        await cache.put(request, response.clone());
        cached += 1;
      } catch {
        failed += 1;
      }

      onProgress?.({
        cached,
        failed,
        total: urls.length,
      });
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(PRIWA_BASEMAP_CACHE_CONCURRENCY, urls.length) },
      () => cacheNextTile(),
    ),
  );

  if (cached === 0) {
    throw new Error("Keine Basiskarten-Kacheln konnten gespeichert werden.");
  }

  return { cached, failed };
};

export const clearPriwaBasemapTileCache = async (projectId: string) => {
  if (!("caches" in globalThis)) return;
  await globalThis.caches.delete(getPriwaBasemapCacheName(projectId));
};
