import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { GeoTIFF } from "ol/source";

import { Settings } from "../../config";
import { COG_SOURCE_OPTIONS } from "../../utils/cogSourceOptions";

export interface IPriwaCogLayerSource {
  cogUrl: string;
  offlineFile?: Blob;
}

export const PRIWA_COG_MAX_ZOOM = 23;

export const resolvePriwaCogUrl = (cogUrl: string) => {
  try {
    return new URL(cogUrl).toString();
  } catch {
    return Settings.COG_BASE_URL + cogUrl.replace(/^\/+/, "");
  }
};

export const createPriwaCogLayer = (cog: IPriwaCogLayerSource) =>
  new TileLayerWebGL({
    source: new GeoTIFF({
      sources: [
        {
          ...(cog.offlineFile
            ? { blob: cog.offlineFile }
            : { url: resolvePriwaCogUrl(cog.cogUrl) }),
          nodata: 0,
          bands: [1, 2, 3],
        },
      ],
      convertToRGB: true,
      interpolate: false,
      sourceOptions: COG_SOURCE_OPTIONS,
    }),
    opacity: 1,
    zIndex: 10,
    cacheSize: 128,
    preload: 0,
  });
