import { GeoTIFF } from "ol/source";

export const COG_SOURCE_OPTIONS = {
  blockSize: 65536,
  cacheSize: 200,
};

/**
 * OpenLayers lets every tile source on a map share one loading budget (16 by
 * default). A dataset map also loads label vector tiles from the database and
 * basemap tiles, each from its own host, so the default leaves COG tiles
 * waiting behind slower layers. The browser still limits connections per host.
 */
export const MAP_MAX_TILES_LOADING = 64;

/**
 * Keep COG range requests out of the browser's HTTP cache. Chrome allows one
 * cache writer per URL, and every range of a COG shares the file's URL, so
 * cacheable range requests run strictly one after another: each tile costs a
 * full round trip and the map sharpens tile by tile. Uncached, the browser
 * sends them in parallel. Blocks already read stay in the geotiff.js block
 * cache for the lifetime of the source.
 */
const COG_FETCH_CACHE_MODE: RequestCache = "no-store";

const RETRY_DELAYS_MS = [300, 1000, 3000];

const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Range request for a COG that survives a transient failure. Without it a
 * single dropped request is permanent: geotiff.js fails the header read, the
 * source goes to its error state for good, and a failed tile is never asked for
 * again, so it stays blurry or blank.
 */
export const fetchCogRange = async (
  url: string,
  headers?: HeadersInit,
  signal?: AbortSignal,
  retryDelaysMs: number[] = RETRY_DELAYS_MS,
): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt >= retryDelaysMs.length;
    try {
      const response = await fetch(url, { headers, signal, cache: COG_FETCH_CACHE_MODE });
      if (isLastAttempt || !isRetryableStatus(response.status)) return response;
    } catch (error) {
      if (isLastAttempt || signal?.aborted) throw error;
    }
    await wait(retryDelaysMs[attempt], signal);
  }
};

/** A remote COG entry for the `sources` of an OpenLayers GeoTIFF source. */
export const remoteCogSource = (url: string) => ({ url, loader: fetchCogRange });

/** RGB orthophoto COG as written by the processor. */
export const createOrthoCogSource = (url: string) =>
  new GeoTIFF({
    sources: [{ ...remoteCogSource(url), nodata: 0, bands: [1, 2, 3] }],
    convertToRGB: true,
    sourceOptions: COG_SOURCE_OPTIONS,
  });

/** Single-band 0-255 cover COG of the satellite maps, shown on its pixel grid. */
const createCoverCogSource = (url: string) =>
  new GeoTIFF({
    sources: [{ ...remoteCogSource(url), bands: [1], min: 0, max: 255 }],
    normalize: true,
    interpolate: false,
    sourceOptions: COG_SOURCE_OPTIONS,
  });

const COVER_SOURCE_CACHE_MAX = 8;
const coverSourceCache = new Map<string, GeoTIFF>();

/**
 * Cover COG sources are kept across year switches and page visits so their
 * headers and tiles are fetched once. A source that failed to load is dropped,
 * so the next request for it starts over instead of staying blank.
 */
export const getCachedCoverCogSource = (url: string): GeoTIFF => {
  const cached = coverSourceCache.get(url);
  if (cached) {
    // Re-insert so the least recently used source is the first key.
    coverSourceCache.delete(url);
    coverSourceCache.set(url, cached);
    return cached;
  }
  const source = createCoverCogSource(url);
  coverSourceCache.set(url, source);
  source.on("change", () => {
    if (source.getState() === "error" && coverSourceCache.get(url) === source) {
      coverSourceCache.delete(url);
    }
  });
  if (coverSourceCache.size > COVER_SOURCE_CACHE_MAX) {
    const oldest = coverSourceCache.keys().next().value;
    if (oldest !== undefined) coverSourceCache.delete(oldest);
  }
  return source;
};
