import type ImageTile from "ol/ImageTile";
import type Tile from "ol/Tile";

/**
 * Esri World Imagery does not have high-zoom pictures everywhere. Where a zoom
 * level is missing, the live endpoint answers 200 with a grey "Map data not yet
 * available" JPEG (always the same bytes) and the Wayback archive answers 404
 * (without CORS headers, so `fetch` rejects). Either way the map shows a hole
 * right where auditors zoom in.
 *
 * This load function instead walks up to the nearest ancestor tile that has
 * real imagery and draws the matching part of it upscaled — the same thing
 * OpenLayers does past a source's maxZoom, just decided per tile.
 */

const PLACEHOLDER_BYTES = 2521;
const PLACEHOLDER_SHA256 =
  "9eafd300d61393184a4abc1d458564cfd1cd9b6f9c4e9c74687045c0a0e5b858";

// 2^8 = 256: one ancestor pixel per tile pixel at the deepest fallback.
const MAX_FALLBACK_LEVELS = 8;

// Neighbouring tiles share ancestors; keep recent ones so a whole viewport of
// missing tiles costs one ancestor download, not one per tile.
const ANCESTOR_CACHE_MAX = 64;

type TileImage = ImageBitmap | null;

const sha256Hex = async (blob: Blob) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
};

export const isEsriPlaceholderTile = async (blob: Blob) =>
  blob.size === PLACEHOLDER_BYTES &&
  (await sha256Hex(blob)) === PLACEHOLDER_SHA256;

/** Resolves to the decoded tile, or null when the server has no imagery there. */
const fetchTileImage = async (url: string): Promise<TileImage> => {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    // Wayback's 404s carry no CORS header, so a missing tile surfaces as a
    // network error. Treating it as missing also covers flaky requests with a
    // coarser picture instead of a hole.
    return null;
  }
  if (!response.ok) return null;
  const blob = await response.blob();
  if (await isEsriPlaceholderTile(blob)) return null;
  return createImageBitmap(blob);
};

export const fillUrlTemplate = (
  template: string,
  z: number,
  x: number,
  y: number,
) =>
  template
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));

export const createImageryFallbackTileLoadFunction = (urlTemplate: string) => {
  const ancestors = new Map<string, Promise<TileImage>>();

  const fetchAncestor = (z: number, x: number, y: number) => {
    const key = `${z}/${x}/${y}`;
    let pending = ancestors.get(key);
    if (pending) {
      ancestors.delete(key);
    } else {
      pending = fetchTileImage(fillUrlTemplate(urlTemplate, z, x, y));
    }
    ancestors.set(key, pending);
    if (ancestors.size > ANCESTOR_CACHE_MAX) {
      const oldest = ancestors.keys().next().value;
      if (oldest !== undefined) ancestors.delete(oldest);
    }
    return pending;
  };

  const load = async (tile: ImageTile, src: string) => {
    const [z, x, y] = tile.getTileCoord();
    const own = await fetchTileImage(src);
    if (own) {
      tile.setImage(drawTile(own, 0, 0, own.width, own.width));
      own.close();
      return;
    }
    for (let depth = 1; depth <= Math.min(MAX_FALLBACK_LEVELS, z); depth++) {
      const ancestor = await fetchAncestor(z - depth, x >> depth, y >> depth);
      if (!ancestor) continue;
      const span = ancestor.width / 2 ** depth;
      const offsetX = (x - ((x >> depth) << depth)) * span;
      const offsetY = (y - ((y >> depth) << depth)) * span;
      tile.setImage(drawTile(ancestor, offsetX, offsetY, span, ancestor.width));
      return;
    }
    // Nothing anywhere up the pyramid: let OpenLayers treat it as an error.
    tile.getImage().dispatchEvent(new Event("error"));
  };

  return (tile: Tile, src: string) => {
    void load(tile as ImageTile, src).catch(() =>
      (tile as ImageTile).getImage().dispatchEvent(new Event("error")),
    );
  };
};

const drawTile = (
  image: ImageBitmap,
  sx: number,
  sy: number,
  sourceSize: number,
  tileSize: number,
) => {
  const canvas = document.createElement("canvas");
  canvas.width = tileSize;
  canvas.height = tileSize;
  const context = canvas.getContext("2d");
  if (context) {
    context.imageSmoothingQuality = "high";
    context.drawImage(
      image,
      sx,
      sy,
      sourceSize,
      sourceSize,
      0,
      0,
      tileSize,
      tileSize,
    );
  }
  return canvas;
};
