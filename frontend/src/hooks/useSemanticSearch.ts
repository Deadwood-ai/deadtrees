import { useCallback, useMemo } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { searchDatasets } from "../api/searchEmbeddings";
import { useAuth } from "./useAuthProvider";

/**
 * URL-backed semantic dataset search.
 *
 * The URL is the durable UI state; React Query owns request lifecycle, cache,
 * and account-specific server state. Old requests cannot overwrite a newer
 * query because each query/user pair has an independent cache key.
 */
export function useSemanticSearch(enabled: boolean) {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get("q")?.trim() || null;
  const query = enabled ? urlQuery : null;
  const actorKey = user?.id ?? "anonymous";

  const {
    data,
    error,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ["semantic-search", actorKey, query],
    queryFn: query ? () => searchDatasets(query) : skipToken,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const scores = useMemo(() => {
    if (!query || !data) return null;
    return new Map(
      data.map((result) => [result.dataset_id, result.similarity]),
    );
  }, [query, data]);

  const run = useCallback(
    (value: string) => {
      const nextQuery = value.trim();
      if (!nextQuery) return;
      if (nextQuery === query) {
        void refetch();
        return;
      }
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.set("q", nextQuery);
        return next;
      });
    },
    [query, refetch, setSearchParams],
  );

  const clear = useCallback(() => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("q");
      return next;
    });
  }, [setSearchParams]);

  return {
    query,
    scores,
    loading: isFetching,
    error: error instanceof Error ? error.message : null,
    run,
    clear,
  };
}
