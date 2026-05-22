import TileLayer from "ol/layer/Tile";
import { XYZ } from "ol/source";

export const PRIWA_TOPOGRAPHIC_TILE_URL_PREFIX =
  "https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR";
export const PRIWA_TOPOGRAPHIC_TILE_URL = `${PRIWA_TOPOGRAPHIC_TILE_URL_PREFIX}/{z}/{y}/{x}.png`;
export const PRIWA_TOPOGRAPHIC_ATTRIBUTION =
  "basemap.de © GeoBasis-DE / BKG";
export const PRIWA_TOPOGRAPHIC_MAX_ZOOM = 19;

export const createPriwaTopographicLayer = () =>
  new TileLayer({
    preload: 1,
    visible: false,
    source: new XYZ({
      url: PRIWA_TOPOGRAPHIC_TILE_URL,
      attributions: PRIWA_TOPOGRAPHIC_ATTRIBUTION,
      maxZoom: PRIWA_TOPOGRAPHIC_MAX_ZOOM,
    }),
  });
