import { useEffect, useState } from "react";
import type { Feature } from "ol";
import type { Map as OLMap } from "ol";
import GeoJSON from "ol/format/GeoJSON";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Fill from "ol/style/Fill";
import Stroke from "ol/style/Stroke";
import Style from "ol/style/Style";

import type { ITileSearchResult } from "../../api/searchEmbeddings";

const HIGHLIGHT_Z_INDEX = 9999;
const FILL_RGB = "217, 70, 239";
const STROKE_RGB = "162, 28, 175";
// Calibrated probabilities below the absolute noise floor are discarded; the
// relative floor keeps broad queries focused on their strongest regions.
const RELATIVE_FLOOR = 0.35;
const ABSOLUTE_FLOOR = 0.1;

function styleForNorm(norm: number): Style {
  const n = Math.max(0, Math.min(1, norm));
  const fillAlpha = 0.06 + 0.34 * n;
  const strokeAlpha = 0.25 + 0.65 * n;
  return new Style({
    stroke: new Stroke({
      color: `rgba(${STROKE_RGB}, ${strokeAlpha.toFixed(2)})`,
      width: 1.5,
    }),
    fill: new Fill({ color: `rgba(${FILL_RGB}, ${fillAlpha.toFixed(2)})` }),
  });
}

/** Own the OpenLayers lifecycle and rendering for semantic tile highlights. */
export function useOrthoTileHighlights(
  map: OLMap | null,
  tiles: ITileSearchResult[],
) {
  const [layer, setLayer] = useState<VectorLayer<VectorSource> | null>(null);
  const [matchCount, setMatchCount] = useState<number | null>(null);

  useEffect(() => {
    if (!map) return;
    const nextLayer = new VectorLayer({
      source: new VectorSource(),
      zIndex: HIGHLIGHT_Z_INDEX,
    });
    map.addLayer(nextLayer);
    setLayer(nextLayer);

    return () => {
      map.removeLayer(nextLayer);
      const source = nextLayer.getSource();
      source?.clear();
      source?.dispose();
      nextLayer.dispose();
      setLayer((current) => (current === nextLayer ? null : current));
    };
  }, [map]);

  useEffect(() => {
    if (!layer || !map) return;
    const source = layer.getSource();
    if (!source) return;
    source.clear();
    if (!tiles.length) {
      setMatchCount(null);
      return;
    }

    const maxSimilarity = Math.max(...tiles.map((tile) => tile.similarity));
    const floor = Math.max(ABSOLUTE_FLOOR, RELATIVE_FLOOR * maxSimilarity);
    const kept = tiles.filter((tile) => tile.similarity >= floor);
    const projection = map.getView().getProjection();
    const format = new GeoJSON();
    const span = Math.max(1e-6, maxSimilarity - floor);

    for (const tile of kept) {
      const feature = format.readFeature(
        { type: "Feature", geometry: tile.geometry, properties: {} },
        { dataProjection: "EPSG:4326", featureProjection: projection },
      ) as Feature;
      feature.setStyle(styleForNorm((tile.similarity - floor) / span));
      source.addFeature(feature);
    }
    setMatchCount(kept.length);
  }, [layer, map, tiles]);

  return matchCount;
}
