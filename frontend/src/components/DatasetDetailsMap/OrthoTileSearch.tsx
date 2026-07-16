import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as OLMap } from "ol";
import { Input, Tooltip } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";

import { searchTiles, ITileSearchResult } from "../../api/searchEmbeddings";
import { useDatasetEmbeddingsAvailability } from "../../hooks/useDatasetEmbeddingsAvailability";
import { useOrthoTileHighlights } from "./useOrthoTileHighlights";

interface OrthoTileSearchProps {
  map: OLMap | null;
  datasetId: number;
  // Query forwarded from the dataset list (?q=...); auto-runs once on mount.
  initialQuery?: string | null;
}

/**
 * Open-vocabulary search scoped to a single orthophoto. Reuses the same backend
 * as the global dataset search and highlights the best-matching tiles on the
 * dataset map. Highlights are easily cleared (clear button / empty the input).
 */
export default function OrthoTileSearch({
  map,
  datasetId,
  initialQuery,
}: OrthoTileSearchProps) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fetched results are kept in state (not drawn imperatively) so they can be
  // re-rendered whenever the highlight layer is (re)created — e.g. React
  // StrictMode's dev double-mount, or the map finishing init after a client-side
  // navigation. Drawing only on fetch lost the highlights in those cases.
  const [tiles, setTiles] = useState<ITileSearchResult[]>([]);
  const autoRan = useRef(false);
  const searchRequest = useRef(0);

  const { availability } = useDatasetEmbeddingsAvailability(datasetId);
  const unavailable = availability === "unavailable";
  const availabilityError = availability === "error";
  const matchCount = useOrthoTileHighlights(map, tiles);

  const clearHighlights = useCallback(() => {
    searchRequest.current += 1;
    setQuery("");
    setLoading(false);
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
      if (availability !== "ready") return;
      const requestId = ++searchRequest.current;
      setLoading(true);
      setError(null);
      try {
        const nextTiles = await searchTiles(trimmed, datasetId);
        if (searchRequest.current === requestId) setTiles(nextTiles);
      } catch (e) {
        if (searchRequest.current === requestId) {
          setError(e instanceof Error ? e.message : "Search failed");
        }
      } finally {
        if (searchRequest.current === requestId) setLoading(false);
      }
    },
    [availability, datasetId, clearHighlights],
  );

  // Auto-run a query forwarded from the dataset list, once the map is ready.
  useEffect(() => {
    if (!map || autoRan.current) return;
    if (availability !== "ready") return;
    if (initialQuery && initialQuery.trim()) {
      autoRan.current = true;
      run(initialQuery);
    }
  }, [map, initialQuery, run, availability]);

  return (
    <div className="w-72 max-w-[80vw]">
      <Input.Search
        placeholder={
          unavailable
            ? "AI search not available yet"
            : availabilityError
              ? "AI search status unavailable"
              : "Search this orthophoto…"
        }
        enterButton
        allowClear
        disabled={availability !== "ready"}
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
          AI search isn't available for this dataset yet — its embeddings
          haven't been generated.
        </div>
      )}
      {availabilityError && (
        <div
          className="mt-1 rounded bg-white/90 px-2 py-0.5 text-xs text-red-500 shadow"
          data-testid="ortho-tile-search-availability-error"
        >
          AI search status couldn't be loaded. Try refreshing the page.
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
