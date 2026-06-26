import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { GeoTIFF } from "ol/source";

import { Settings } from "../../config";
import { COG_SOURCE_OPTIONS } from "../../utils/cogSourceOptions";

export interface IPriwaCogLayerSource {
  cogUrl: string;
}

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
          url: resolvePriwaCogUrl(cog.cogUrl),
          nodata: 0,
          bands: [1, 2, 3],
        },
      ],
      convertToRGB: true,
      sourceOptions: COG_SOURCE_OPTIONS,
    }),
    opacity: 0.82,
    maxZoom: 23,
    zIndex: 10,
    cacheSize: 4096,
    preload: 0,
  });

export const createPriwaCogLayers = (cogs: IPriwaCogLayerSource[]) =>
  cogs.map((cog) => createPriwaCogLayer(cog));
