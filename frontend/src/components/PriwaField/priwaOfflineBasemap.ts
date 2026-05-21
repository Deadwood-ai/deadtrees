import {
  LGL_DOP20_FORMAT,
  LGL_DOP20_LAYER,
  LGL_DOP20_MATRIX_SET,
  LGL_DOP20_STYLE,
  LGL_DOP20_WMTS_URL,
} from "./createLglDop20Layer";

export const PRIWA_BASEMAP_CACHE = "deadtrees-priwa-basemap-v1";
export const PRIWA_BASEMAP_MIN_ZOOM = 16;
export const PRIWA_BASEMAP_MAX_ZOOM = 20;
export const PRIWA_BASEMAP_MAX_TILES = 600;
export const PRIWA_BASEMAP_MAX_AREA_KM2 = 2;

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

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const tileSpanForZoom = (zoom: number) =>
  (WEB_MERCATOR_HALF_WORLD * 2) / 2 ** zoom;

const tileRangeForExtent = (
  extent3857: [number, number, number, number],
  zoom: number,
) => {
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
      Math.floor((maxX + WEB_MERCATOR_HALF_WORLD) / tileSpan),
      0,
      maxTile,
    ),
    minRow: clamp(
      Math.floor((WEB_MERCATOR_HALF_WORLD - maxY) / tileSpan),
      0,
      maxTile,
    ),
    maxRow: clamp(
      Math.floor((WEB_MERCATOR_HALF_WORLD - minY) / tileSpan),
      0,
      maxTile,
    ),
  };
};

export const createPriwaBasemapTileUrl = ({
  zoom,
  row,
  col,
}: {
  zoom: number;
  row: number;
  col: number;
}) => {
  const params = new URLSearchParams({
    SERVICE: "WMTS",
    REQUEST: "GetTile",
    VERSION: "1.0.0",
    LAYER: LGL_DOP20_LAYER,
    STYLE: LGL_DOP20_STYLE,
    TILEMATRIXSET: LGL_DOP20_MATRIX_SET,
    TILEMATRIX: `${LGL_DOP20_MATRIX_SET}:${zoom}`,
    TILEROW: String(row),
    TILECOL: String(col),
    FORMAT: LGL_DOP20_FORMAT,
  });

  return `${LGL_DOP20_WMTS_URL}?${params.toString()}`;
};

export const buildPriwaBasemapTilePlan = (
  extent3857: [number, number, number, number],
  zoom: number,
): IPriwaBasemapTilePlan => {
  const roundedZoom = clamp(
    Math.round(zoom),
    PRIWA_BASEMAP_MIN_ZOOM,
    PRIWA_BASEMAP_MAX_ZOOM,
  );
  const minZoom = clamp(
    roundedZoom - 1,
    PRIWA_BASEMAP_MIN_ZOOM,
    PRIWA_BASEMAP_MAX_ZOOM,
  );
  const maxZoom = clamp(
    roundedZoom + 1,
    PRIWA_BASEMAP_MIN_ZOOM,
    PRIWA_BASEMAP_MAX_ZOOM,
  );
  const urls: string[] = [];

  for (let tileZoom = minZoom; tileZoom <= maxZoom; tileZoom += 1) {
    const range = tileRangeForExtent(extent3857, tileZoom);
    for (let row = range.minRow; row <= range.maxRow; row += 1) {
      for (let col = range.minCol; col <= range.maxCol; col += 1) {
        urls.push(createPriwaBasemapTileUrl({ zoom: tileZoom, row, col }));
      }
    }
  }

  const [minX, minY, maxX, maxY] = extent3857;
  const areaKm2 = Math.abs((maxX - minX) * (maxY - minY)) / 1_000_000;

  return {
    extent3857,
    areaKm2,
    minZoom,
    maxZoom,
    tileCount: urls.length,
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
  urls: string[],
  onProgress?: PriwaBasemapProgressHandler,
): Promise<IPriwaBasemapCacheResult> => {
  if (!("caches" in globalThis)) {
    throw new Error(
      "Offline-Kartenspeicher wird von diesem Browser nicht unterstützt.",
    );
  }

  const cache = await globalThis.caches.open(PRIWA_BASEMAP_CACHE);
  let cached = 0;
  let failed = 0;

  for (const url of urls) {
    try {
      const request = new Request(url, {
        cache: "reload",
        mode: "no-cors",
      });
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

  if (cached === 0) {
    throw new Error("Keine Basiskarten-Kacheln konnten gespeichert werden.");
  }

  return { cached, failed };
};

export const clearPriwaBasemapTileCache = async () => {
  if (!("caches" in globalThis)) return;
  await globalThis.caches.delete(PRIWA_BASEMAP_CACHE);
};
