import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as OLMap } from "ol";
import type { Feature } from "ol";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import GeoJSON from "ol/format/GeoJSON";
import Style from "ol/style/Style";
import Stroke from "ol/style/Stroke";
import Fill from "ol/style/Fill";
import { Input, Tooltip } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";

import { searchTiles, ITileSearchResult } from "../../api/searchEmbeddings";
import { useDatasetEmbeddingsReady } from "../../hooks/useDatasetAudit";

interface OrthoTileSearchProps {
  map: OLMap | null;
  datasetId: number;
  // Query forwarded from the dataset list (?q=...); auto-runs once on mount.
  initialQuery?: string | null;
}

// Draw highlight tiles above all other layers.
const HIGHLIGHT_Z_INDEX = 9999;

// Magenta highlight: an unnatural color that almost never occurs in forests or
// other terrestrial surfaces (green/brown/tan), so matches pop against the
// imagery instead of blending into autumn foliage, bare soil or dry vegetation.
const FILL_RGB = "217, 70, 239"; // fuchsia-500
const STROKE_RGB = "162, 28, 175"; // fuchsia-700

// Backend similarity is a calibrated match probability (softmax of the query vs
// a bank of background prompts), so it's comparable across queries and has a
// meaningful noise floor: "nothing here" queries top out around ~0.05-0.09,
// while genuine matches form a cluster above ~0.10. ABSOLUTE_FLOOR is therefore
// a principled minimum confidence (keeps no-match searches empty), and
// RELATIVE_FLOOR keeps broad queries focused on their strongest regions without
// dropping graded matches. Weak kept tiles fade out via the opacity ramp below.
const RELATIVE_FLOOR = 0.35;
const ABSOLUTE_FLOOR = 0.1;

/** Heat highlight whose fill AND border opacity scale with normalized relevance. */
function styleForNorm(norm: number): Style {
  const n = Math.max(0, Math.min(1, norm));
  const fillAlpha = 0.06 + 0.34 * n;
  const strokeAlpha = 0.25 + 0.65 * n;
  return new Style({
    stroke: new Stroke({ color: `rgba(${STROKE_RGB}, ${strokeAlpha.toFixed(2)})`, width: 1.5 }),
    fill: new Fill({ color: `rgba(${FILL_RGB}, ${fillAlpha.toFixed(2)})` }),
  });
}

/**
 * Open-vocabulary search scoped to a single orthophoto. Reuses the same backend
 * as the global dataset search and highlights the best-matching tiles on the
 * dataset map. Highlights are easily cleared (clear button / empty the input).
 */
export default function OrthoTileSearch({ map, datasetId, initialQuery }: OrthoTileSearchProps) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  // Fetched results are kept in state (not drawn imperatively) so they can be
  // re-rendered whenever the highlight layer is (re)created — e.g. React
  // StrictMode's dev double-mount, or the map finishing init after a client-side
  // navigation. Drawing only on fetch lost the highlights in those cases.
  const [tiles, setTiles] = useState<ITileSearchResult[]>([]);
  const [layer, setLayer] = useState<VectorLayer<VectorSource> | null>(null);
  const autoRan = useRef(false);

  // Embeddings are generated per dataset; the tile search is meaningless until
  // they exist. `undefined` while the status loads — only treat as unavailable
  // once we positively know embeddings aren't done yet.
  const { data: embeddingsReady } = useDatasetEmbeddingsReady(datasetId);
  const unavailable = embeddingsReady === false;

  // Create a dedicated highlight layer once the map is available.
  useEffect(() => {
    if (!map) return;
    const lyr = new VectorLayer({ source: new VectorSource(), zIndex: HIGHLIGHT_Z_INDEX });
    map.addLayer(lyr);
    setLayer(lyr);
    return () => {
      map.removeLayer(lyr);
      // Dispose the layer and its source so OpenLayers tears down the event
      // listeners they hold; otherwise repeated mount/unmount (navigating
      // between datasets) leaks sources that can never be GC'd.
      const source = lyr.getSource();
      source?.clear();
      source?.dispose();
      lyr.dispose();
      setLayer((prev) => (prev === lyr ? null : prev));
    };
  }, [map]);

  // Render the current results whenever they change OR the layer is recreated.
  useEffect(() => {
    if (!layer || !map) return;
    const source = layer.getSource();
    if (!source) return;
    source.clear();
    if (!tiles.length) {
      setMatchCount(null);
      return;
    }

    // Drop low-confidence tiles: keep those at least RELATIVE_FLOOR of the best
    // match and above the absolute floor.
    const maxSimilarity = Math.max(...tiles.map((t) => t.similarity));
    const floor = Math.max(ABSOLUTE_FLOOR, RELATIVE_FLOOR * maxSimilarity);
    const kept = tiles.filter((t) => t.similarity >= floor);
    const projection = map.getView().getProjection();
    const format = new GeoJSON();
    const span = Math.max(1e-6, maxSimilarity - floor);

    for (const tile of kept) {
      const feature = format.readFeature(
        { type: "Feature", geometry: tile.geometry, properties: {} },
        { dataProjection: "EPSG:4326", featureProjection: projection },
      ) as Feature;
      // Normalize opacity across the kept range so the best match is fully
      // saturated and the weakest kept tile is still faintly visible.
      feature.setStyle(styleForNorm((tile.similarity - floor) / span));
      source.addFeature(feature);
    }
    setMatchCount(kept.length);
  }, [layer, tiles, map]);

  const clearHighlights = useCallback(() => {
    setQuery("");
    setError(null);
    setTiles([]); // the render effect clears the layer + resets the count
  }, []);

  const run = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) {
        clearHighlights();
        return;
      }
      setLoading(true);
      setError(null);
      try {
        setTiles(await searchTiles(trimmed, datasetId)); // render happens in the effect
      } catch (e) {
        setError(e instanceof Error ? e.message : "Search failed");
      } finally {
        setLoading(false);
      }
    },
    [datasetId, clearHighlights],
  );

  // Auto-run a query forwarded from the dataset list, once the map is ready.
  useEffect(() => {
    if (!map || autoRan.current) return;
    if (!embeddingsReady) return; // wait until we know this dataset has embeddings
    if (initialQuery && initialQuery.trim()) {
      autoRan.current = true;
      run(initialQuery);
    }
  }, [map, initialQuery, run, embeddingsReady]);

  return (
    <div className="w-72 max-w-[80vw]">
      <Input.Search
        placeholder={
          unavailable ? "AI search not available yet" : "Search this orthophoto…"
        }
        enterButton
        allowClear
        disabled={unavailable}
        loading={loading}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!e.target.value) clearHighlights();
        }}
        onSearch={(value) => run(value)}
        data-testid="ortho-tile-search-input"
        suffix={
          <Tooltip
            placement="bottomRight"
            styles={{ root: { maxWidth: 280 } }}
            title={
              <div className="text-xs">
                <p className="mb-1">
                  Describe what you're looking for in plain language and the
                  best-matching areas of this orthophoto are highlighted in
                  magenta.
                </p>
                <p className="mb-0.5 font-medium">Try, for example:</p>
                <p className="mb-0">
                  fire · fallen trees · road · water · clearing · bare soil ·
                  buildings
                </p>
              </div>
            }
          >
            <InfoCircleOutlined
              className="text-gray-400 hover:text-gray-600"
              data-testid="ortho-tile-search-help"
            />
          </Tooltip>
        }
      />
      {unavailable && (
        <div
          className="mt-1 rounded bg-white/90 px-2 py-0.5 text-xs text-gray-500 shadow"
          data-testid="ortho-tile-search-unavailable"
        >
          AI search isn't available for this dataset yet — its embeddings haven't
          been generated.
        </div>
      )}
      {matchCount !== null && (
        <div className="mt-1 flex items-center justify-between rounded bg-white/90 px-2 py-0.5 text-xs text-gray-600 shadow">
          <span>
            {matchCount > 0
              ? `${matchCount} matching ${matchCount === 1 ? "tile" : "tiles"} highlighted`
              : "No strong matches in this orthophoto"}
          </span>
          <button
            type="button"
            className="font-medium text-fuchsia-600 hover:text-fuchsia-800"
            onClick={clearHighlights}
          >
            Clear
          </button>
        </div>
      )}
      {error && <div className="mt-1 text-xs text-red-500">{error}</div>}
    </div>
  );
}
