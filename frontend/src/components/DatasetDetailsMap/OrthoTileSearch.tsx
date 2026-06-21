import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as OLMap } from "ol";
import type { Feature } from "ol";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import GeoJSON from "ol/format/GeoJSON";
import Style from "ol/style/Style";
import Stroke from "ol/style/Stroke";
import Fill from "ol/style/Fill";
import { Input } from "antd";

import { searchTiles, TileSearchResult } from "../../api/searchEmbeddings";

interface OrthoTileSearchProps {
  map: OLMap | null;
  datasetId: number;
  // Query forwarded from the dataset list (?q=...); auto-runs once on mount.
  initialQuery?: string | null;
}

// Draw highlight tiles above all other layers.
const HIGHLIGHT_Z_INDEX = 9999;

/** Purple highlight whose opacity scales with relative relevance. */
function styleForSimilarity(similarity: number, maxSimilarity: number): Style {
  const norm = maxSimilarity > 0 ? similarity / maxSimilarity : similarity;
  const alpha = 0.12 + 0.5 * Math.max(0, Math.min(1, norm));
  return new Style({
    stroke: new Stroke({ color: "rgba(124, 58, 237, 0.95)", width: 2 }),
    fill: new Fill({ color: `rgba(168, 85, 247, ${alpha.toFixed(2)})` }),
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
  const layerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const autoRan = useRef(false);

  // Create a dedicated highlight layer once the map is available.
  useEffect(() => {
    if (!map) return;
    const source = new VectorSource();
    const layer = new VectorLayer({ source, zIndex: HIGHLIGHT_Z_INDEX });
    layerRef.current = layer;
    map.addLayer(layer);
    return () => {
      map.removeLayer(layer);
      layerRef.current = null;
    };
  }, [map]);

  const renderTiles = useCallback(
    (tiles: TileSearchResult[]) => {
      const layer = layerRef.current;
      if (!layer || !map) return;
      const source = layer.getSource();
      if (!source) return;
      source.clear();
      if (!tiles.length) return;

      const projection = map.getView().getProjection();
      const format = new GeoJSON();
      const maxSimilarity = Math.max(...tiles.map((t) => t.similarity));

      const features = tiles.map((tile) => {
        const feature = format.readFeature(
          { type: "Feature", geometry: tile.geometry, properties: {} },
          { dataProjection: "EPSG:4326", featureProjection: projection },
        ) as Feature;
        feature.setStyle(styleForSimilarity(tile.similarity, maxSimilarity));
        return feature;
      });
      source.addFeatures(features);

      // Zoom to the single best-matching tile.
      const bestIndex = tiles.reduce(
        (best, tile, idx) => (tile.similarity > tiles[best].similarity ? idx : best),
        0,
      );
      const bestGeometry = features[bestIndex]?.getGeometry();
      if (bestGeometry) {
        map.getView().fit(bestGeometry.getExtent(), {
          padding: [80, 80, 80, 80],
          maxZoom: 18,
          duration: 500,
        });
      }
    },
    [map],
  );

  const clearHighlights = useCallback(() => {
    setQuery("");
    setMatchCount(null);
    setError(null);
    layerRef.current?.getSource()?.clear();
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
        const tiles = await searchTiles(trimmed, datasetId);
        renderTiles(tiles);
        setMatchCount(tiles.length);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Search failed");
      } finally {
        setLoading(false);
      }
    },
    [datasetId, renderTiles, clearHighlights],
  );

  // Auto-run a query forwarded from the dataset list, once the map is ready.
  useEffect(() => {
    if (!map || autoRan.current) return;
    if (initialQuery && initialQuery.trim()) {
      autoRan.current = true;
      run(initialQuery);
    }
  }, [map, initialQuery, run]);

  return (
    <div className="w-72 max-w-[80vw]">
      <Input.Search
        placeholder="Search this orthophoto…"
        enterButton
        allowClear
        loading={loading}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!e.target.value) clearHighlights();
        }}
        onSearch={(value) => run(value)}
        data-testid="ortho-tile-search-input"
      />
      {matchCount !== null && (
        <div className="mt-1 flex items-center justify-between rounded bg-white/90 px-2 py-0.5 text-xs text-gray-600 shadow">
          <span>{matchCount} matching tiles highlighted</span>
          <button
            type="button"
            className="font-medium text-purple-600 hover:text-purple-800"
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
