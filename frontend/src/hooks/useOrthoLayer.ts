import { useEffect, useRef, type MutableRefObject } from "react";
import type { Map } from "ol";
import TileLayerWebGL from "ol/layer/WebGLTile";
import { createOrthoCogSource } from "../utils/cogSource";

interface OrthoLayerOptions {
  /** Highest zoom the imagery layer renders. */
  maxZoom: number;
  /** Highest zoom used when first fitting the view to the imagery. */
  fitMaxZoom: number;
}

/**
 * Keeps the map's orthophoto layer in step with its COG address. Private
 * datasets get their signed address after the map exists and renew it before it
 * expires, so the layer is (re)built whenever the address changes. The view is
 * fitted to the imagery once, not on every renewal.
 */
export function useOrthoLayer(
  mapRef: MutableRefObject<Map | null>,
  layerRef: MutableRefObject<TileLayerWebGL | null>,
  cogUrl: string | null,
  { maxZoom, fitMaxZoom }: OrthoLayerOptions,
) {
  const fitted = useRef(false);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (layerRef.current) {
      map.removeLayer(layerRef.current);
      layerRef.current.dispose();
      layerRef.current = null;
    }
    if (!cogUrl) return;

    const ortho = new TileLayerWebGL({
      source: createOrthoCogSource(cogUrl),
      maxZoom,
      cacheSize: 1024,
      preload: 0,
    });
    ortho.setZIndex(1); // above the basemap, below every vector layer
    layerRef.current = ortho;
    map.addLayer(ortho);

    if (fitted.current) return;
    ortho
      .getSource()
      ?.getView()
      .then((viewOptions) => {
        const extent = (viewOptions as { extent?: [number, number, number, number] })?.extent;
        if (extent) {
          map.getView().fit(extent, { padding: [20, 20, 20, 20], maxZoom: fitMaxZoom, duration: 200 });
          fitted.current = true;
        }
      })
      .catch(() => {});
  }, [mapRef, layerRef, cogUrl, maxZoom, fitMaxZoom]);
}
