import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { GeoTIFF } from "ol/source";

import { Settings } from "../../config";

export const createPriwaCogLayer = (cogPath: string) =>
  new TileLayerWebGL({
    source: new GeoTIFF({
      sources: [
        {
          url: Settings.COG_BASE_URL + cogPath,
          nodata: 0,
          bands: [1, 2, 3],
        },
      ],
      convertToRGB: true,
    }),
    opacity: 0.82,
    maxZoom: 23,
    zIndex: 10,
    cacheSize: 4096,
    preload: 0,
  });
