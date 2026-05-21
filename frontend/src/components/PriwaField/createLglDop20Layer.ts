import TileLayer from "ol/layer/Tile";
import { get as getProjection } from "ol/proj";
import WMTS from "ol/source/WMTS";
import WMTSTileGrid from "ol/tilegrid/WMTS";
import { getTopLeft, getWidth } from "ol/extent";

export const LGL_DOP20_WMTS_URL =
  "https://owsproxy.lgl-bw.de/owsproxy/ows/WMTS_LGL-BW_ATKIS_DOP_20_C";
export const LGL_DOP20_LAYER = "DOP_20_C";
export const LGL_DOP20_MATRIX_SET = "GoogleMapsCompatible";
export const LGL_DOP20_FORMAT = "image/jpeg";
export const LGL_DOP20_STYLE = "default";
export const LGL_DOP20_ATTRIBUTION = "Datengrundlage: LGL, www.lgl-bw.de";

export const createLglDop20Layer = () => {
  const projection = getProjection("EPSG:3857");
  if (!projection) {
    throw new Error("EPSG:3857 projection is unavailable");
  }

  const projectionExtent = projection.getExtent();
  const baseResolution = getWidth(projectionExtent) / 256;
  const resolutions = Array.from(
    { length: 21 },
    (_, zoom) => baseResolution / 2 ** zoom,
  );
  const matrixIds = resolutions.map(
    (_, zoom) => `GoogleMapsCompatible:${zoom}`,
  );

  return new TileLayer({
    preload: 1,
    source: new WMTS({
      url: LGL_DOP20_WMTS_URL,
      layer: LGL_DOP20_LAYER,
      matrixSet: LGL_DOP20_MATRIX_SET,
      format: LGL_DOP20_FORMAT,
      style: LGL_DOP20_STYLE,
      projection,
      tileGrid: new WMTSTileGrid({
        origin: getTopLeft(projectionExtent),
        resolutions,
        matrixIds,
      }),
      attributions: LGL_DOP20_ATTRIBUTION,
      wrapX: true,
    }),
  });
};
