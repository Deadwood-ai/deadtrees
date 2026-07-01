import type { QueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router-dom";

import type { AuthStatus } from "../hooks/useAuthProvider";

export type DatasetDetailCacheRecord = { id: number };

export function getPublicDatasetByIdQueryKey(
  datasetId: number | undefined,
  authStatus: AuthStatus,
  userId?: string | null,
) {
  return ["public-dataset-by-id", datasetId, authStatus, userId ?? "anonymous"] as const;
}

export function openDatasetDetail({
  queryClient,
  navigate,
  dataset,
  authStatus,
  userId,
}: {
  queryClient: QueryClient;
  navigate: NavigateFunction;
  dataset: DatasetDetailCacheRecord;
  authStatus: AuthStatus;
  userId?: string | null;
}) {
  const queryKey = getPublicDatasetByIdQueryKey(dataset.id, authStatus, userId);

  queryClient.setQueryData(queryKey, dataset);
  void queryClient.invalidateQueries({
    queryKey,
    exact: true,
    refetchType: "none",
  });

  navigate(`/dataset/${dataset.id}`);
}
