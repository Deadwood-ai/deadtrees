import type { QueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router-dom";

import type { AuthStatus } from "../hooks/useAuthProvider";

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
  datasetId,
  authStatus,
  userId,
}: {
  queryClient: QueryClient;
  navigate: NavigateFunction;
  datasetId: number;
  authStatus: AuthStatus;
  userId?: string | null;
}) {
  const queryKey = getPublicDatasetByIdQueryKey(datasetId, authStatus, userId);

  void queryClient.invalidateQueries({
    queryKey,
    exact: true,
    refetchType: "none",
  });

  navigate(`/dataset/${datasetId}`);
}
