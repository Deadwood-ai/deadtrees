import React, { createContext, useCallback, useContext, useState } from "react";

import { searchDatasets } from "../api/searchEmbeddings";

export interface SemanticSearchState {
  /** The query that produced the current results (null when inactive). */
  query: string | null;
  /** dataset_id -> best tile similarity (0..1), ordered by relevance. */
  scores: Map<number, number> | null;
  /** dataset_ids ordered most-relevant first. */
  rankedIds: number[] | null;
  loading: boolean;
  error: string | null;
  /** Current text in the search box (kept here so it survives navigation). */
  input: string;
  setInput: (value: string) => void;
  run: (query: string) => Promise<void>;
  clear: () => void;
}

const noop = () => {};

const SemanticSearchContext = createContext<SemanticSearchState>({
  query: null,
  scores: null,
  rankedIds: null,
  loading: false,
  error: null,
  input: "",
  setInput: noop,
  run: async () => {},
  clear: noop,
});

/**
 * Open-vocabulary (CLIP) dataset ranking. Coexists with the existing text
 * filter: when a query is active the caller restricts + reorders the dataset
 * list by score.
 *
 * State lives in a provider mounted above the router (main.tsx), so that
 * navigating into a dataset and pressing back preserves the active search and
 * its results — mirroring how DatasetFilterProvider persists the text filters.
 */
export const SemanticSearchProvider = (props: { children: React.ReactNode }) => {
  const [query, setQuery] = useState<string | null>(null);
  const [scores, setScores] = useState<Map<number, number> | null>(null);
  const [rankedIds, setRankedIds] = useState<number[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");

  const run = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const results = await searchDatasets(trimmed);
      const scoreMap = new Map<number, number>();
      const ids: number[] = [];
      for (const r of results) {
        scoreMap.set(r.dataset_id, r.similarity);
        ids.push(r.dataset_id);
      }
      setScores(scoreMap);
      setRankedIds(ids);
      setQuery(trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
      setScores(null);
      setRankedIds(null);
      setQuery(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const clear = useCallback(() => {
    setQuery(null);
    setScores(null);
    setRankedIds(null);
    setError(null);
    setInput("");
  }, []);

  return (
    <SemanticSearchContext.Provider
      value={{ query, scores, rankedIds, loading, error, input, setInput, run, clear }}
    >
      {props.children}
    </SemanticSearchContext.Provider>
  );
};

export const useSemanticSearch = () => useContext(SemanticSearchContext);
