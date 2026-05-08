import TileLayer from "ol/layer/Tile";
import { get as getProjection } from "ol/proj";
import WMTS from "ol/source/WMTS";
import WMTSTileGrid from "ol/tilegrid/WMTS";
import { getTopLeft, getWidth } from "ol/extent";

const LGL_DOP20_WMTS_URL =
  "https://owsproxy.lgl-bw.de/owsproxy/ows/WMTS_LGL-BW_ATKIS_DOP_20_C";
const LGL_DOP20_ATTRIBUTION = "Datengrundlage: LGL, www.lgl-bw.de";

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
      layer: "DOP_20_C",
      matrixSet: "GoogleMapsCompatible",
      format: "image/jpeg",
      style: "default",
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
