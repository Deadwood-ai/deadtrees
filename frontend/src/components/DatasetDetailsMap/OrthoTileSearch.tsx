import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as OLMap } from "ol";
import { Button, Input, Tooltip } from "antd";
import {
  CloseOutlined,
  EnterOutlined,
  InfoCircleOutlined,
  SearchOutlined,
} from "@ant-design/icons";

import { searchTiles, ITileSearchResult } from "../../api/searchEmbeddings";
import { useDatasetEmbeddingsAvailability } from "../../hooks/useDatasetEmbeddingsAvailability";
import { useOrthoTileHighlights } from "./useOrthoTileHighlights";

interface OrthoTileSearchProps {
  map: OLMap | null;
  datasetId: number;
  // Query forwarded from the dataset list (?q=...); auto-runs once on mount.
  initialQuery?: string | null;
}

// Shared floating-card shell: matches the layer panel and the satellite map's
// location search so every map overlay reads as one family.
const CARD_CLASS =
  "rounded-2xl border border-gray-200/60 bg-white/95 shadow-xl backdrop-blur-sm";

function SearchNotice({
  children,
  testId,
  onDismiss,
}: {
  children: string;
  testId: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className={`flex items-center gap-2 py-1.5 pl-3.5 pr-1.5 text-sm text-gray-600 ${CARD_CLASS}`}
    >
      <InfoCircleOutlined aria-hidden className="text-gray-400" />
      <span data-testid={testId}>{children}</span>
      <Button
        type="text"
        size="small"
        aria-label="Dismiss"
        icon={<CloseOutlined />}
        onClick={onDismiss}
      />
    </div>
  );
}

/**
 * Open-vocabulary search scoped to a single orthophoto. Reuses the same backend
 * as the global dataset search and highlights the best-matching areas on the
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
  const [noticeDismissed, setNoticeDismissed] = useState(false);
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

  // Do not advertise an action that this image cannot perform. Only a search
  // explicitly forwarded from the archive earns a short, dismissible explanation.
  if (availability === "loading") return null;
  if (noticeDismissed && (unavailable || availabilityError)) return null;
  if (unavailable && !initialQuery?.trim()) return null;
  if (unavailable) {
    return (
      <SearchNotice
        testId="ortho-tile-search-unavailable"
        onDismiss={() => setNoticeDismissed(true)}
      >
        AI search is not available for this image.
      </SearchNotice>
    );
  }
  if (availabilityError) {
    return (
      <SearchNotice
        testId="ortho-tile-search-availability-error"
        onDismiss={() => setNoticeDismissed(true)}
      >
        AI search is temporarily unavailable. Try refreshing the page.
      </SearchNotice>
    );
  }

  const status = error
    ? { tone: "text-red-600", text: error }
    : matchCount === null
      ? null
      : {
          tone: "text-gray-600",
          text:
            matchCount > 0
              ? `${matchCount} matching ${matchCount === 1 ? "area" : "areas"} highlighted`
              : "No strong matches in this image",
        };

  return (
    <div
      className={`w-[calc(100vw-1rem)] md:w-80 transition-shadow focus-within:border-green-800/50 focus-within:ring-2 focus-within:ring-green-800/10 ${CARD_CLASS}`}
      data-testid="ortho-tile-search"
    >
      <div className="flex items-center gap-1 py-1 pl-3.5 pr-1.5">
        <SearchOutlined aria-hidden className="shrink-0 text-gray-500" />
        <Input
          variant="borderless"
          className="min-w-0 flex-1"
          aria-label="Find in this image"
          placeholder="Find in this image, e.g. fallen trees"
          allowClear
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value) clearHighlights();
          }}
          onPressEnter={() => run(query)}
          data-testid="ortho-tile-search-input"
        />
        <Tooltip
          placement="bottomRight"
          styles={{ root: { maxWidth: 280 } }}
          title={
            <div className="text-xs">
              <p className="mb-1">
                Describe what you are looking for in plain language. The
                best-matching areas of this image are highlighted in magenta.
              </p>
              <p className="mb-0.5 font-medium">Try, for example:</p>
              <p className="mb-0">
                fire · fallen trees · road · water · clearing · bare soil ·
                buildings
              </p>
            </div>
          }
        >
          <Button
            type="text"
            size="small"
            aria-label="How AI search works"
            icon={<InfoCircleOutlined className="text-gray-400" />}
            data-testid="ortho-tile-search-help"
          />
        </Tooltip>
        <Button
          type="text"
          size="small"
          aria-label="Run search"
          icon={<EnterOutlined />}
          loading={loading}
          disabled={!query.trim()}
          onClick={() => run(query)}
        />
      </div>
      {status && (
        <div
          role="status"
          className={`flex items-center justify-between gap-3 border-t border-gray-100 px-3.5 py-1.5 text-xs ${status.tone}`}
        >
          <span>{status.text}</span>
          {matchCount !== null && (
            <button
              type="button"
              className="shrink-0 font-medium text-fuchsia-600 hover:text-fuchsia-800"
              onClick={clearHighlights}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
