import { useCallback, useMemo } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchDatasetAccessRoster,
  fetchDatasetsSharedWithMe,
  fetchMyDatasetAccess,
  fetchPrivateDatasetFilesBatched,
  fetchPublicCogPath,
  revokeDatasetAccess,
  searchShareAccounts,
  setDatasetAccess,
  updateDatasetVisibility,
  type DatasetAccessRole,
} from "../api/datasetAccess";
import { useAuth } from "./useAuthProvider";
import type { IDataAccess } from "../types/dataset";
import { isPrivateDataset, resolveDatasetFileUrls, type IDatasetFileSource } from "../utils/datasetFileUrls";

// Signed file addresses are valid for an hour; renew them well before that.
const PRIVATE_FILE_REFRESH_MS = 45 * 60 * 1000;

export const datasetAccessKey = (datasetId: number, userId?: string) => ["datasets", datasetId, "access", userId];
const rosterKey = (datasetId: number, userId?: string) => ["datasets", datasetId, "access-roster", userId];
const sharedWithMeKey = (userId?: string) => ["datasets", "shared-with-me", userId];

export function useMyDatasetAccess(datasetId: number | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: datasetAccessKey(datasetId ?? 0, user?.id),
    queryFn: () => fetchMyDatasetAccess(datasetId as number),
    enabled: !!datasetId && !!user?.id,
  });
}

export function useDatasetAccessRoster(datasetId: number, enabled: boolean) {
  const { user } = useAuth();
  return useQuery({
    queryKey: rosterKey(datasetId, user?.id),
    queryFn: () => fetchDatasetAccessRoster(datasetId),
    enabled: enabled && !!user?.id,
  });
}

// The database returns no matches for shorter queries.
const SHARE_ACCOUNT_SEARCH_MIN_LENGTH = 3;

/** Account emails matching a typed query; `searching` is false while the query is too short. */
export function useShareAccountSearch(datasetId: number, query: string) {
  const { user } = useAuth();
  const trimmed = query.trim().toLowerCase();
  const searching = !!user?.id && trimmed.length >= SHARE_ACCOUNT_SEARCH_MIN_LENGTH;
  const search = useQuery({
    queryKey: ["datasets", datasetId, "share-accounts", trimmed, user?.id],
    queryFn: () => searchShareAccounts(datasetId, trimmed),
    enabled: searching,
    staleTime: 60 * 1000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  return { search, searching };
}

export function useSharedWithMe() {
  const { user } = useAuth();
  return useQuery({
    queryKey: sharedWithMeKey(user?.id),
    queryFn: fetchDatasetsSharedWithMe,
    enabled: !!user?.id,
  });
}

export function useChangeDatasetAccess(datasetId: number) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["datasets", datasetId] });
  const grant = useMutation({
    mutationFn: (input: { email: string; role: DatasetAccessRole; canDownload: boolean; expiresAt: string | null }) =>
      setDatasetAccess(datasetId, input.email, input.role, input.canDownload, input.expiresAt),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (userId: string) => revokeDatasetAccess(datasetId, userId),
    onSuccess: refresh,
  });
  return { grant, revoke };
}

export function useUpdateDatasetVisibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { datasetId: number; dataAccess: IDataAccess }) =>
      updateDatasetVisibility(input.datasetId, input.dataAccess),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

/**
 * COG/thumbnail addresses for several datasets. Private ones are fetched as signed
 * addresses for the signed-in user; public files use the access-checked legacy URL.
 */
export function useDatasetFileUrlResolver(datasets: IDatasetFileSource[]) {
  const { user } = useAuth();
  const privateIds = useMemo(
    () => [...new Set(datasets.filter(isPrivateDataset).map((dataset) => dataset.id))].sort((a, b) => a - b),
    [datasets],
  );
  const { data: privateFiles } = useQuery({
    queryKey: ["datasets", "private-files", privateIds, user?.id],
    queryFn: () => fetchPrivateDatasetFilesBatched(privateIds),
    enabled: privateIds.length > 0 && !!user?.id,
    staleTime: PRIVATE_FILE_REFRESH_MS,
    refetchInterval: PRIVATE_FILE_REFRESH_MS,
  });
  return useCallback(
    (dataset: IDatasetFileSource) => resolveDatasetFileUrls(dataset, privateFiles?.[dataset.id]),
    [privateFiles],
  );
}

/** Thumbnail address only; lists use this so they never spend the COG path allowance. */
export function useDatasetThumbnailUrl(dataset: IDatasetFileSource | null | undefined): string | null {
  const datasets = useMemo(() => (dataset ? [dataset] : []), [dataset]);
  const resolve = useDatasetFileUrlResolver(datasets);
  return dataset ? resolve(dataset).thumbnailUrl : null;
}

/**
 * COG and thumbnail addresses for one dataset's map. When the database does not
 * list the COG path to this caller, it is fetched from the capped API once per session.
 */
export function useDatasetFileUrls(dataset: IDatasetFileSource | null | undefined) {
  const datasets = useMemo(() => (dataset ? [dataset] : []), [dataset]);
  const resolve = useDatasetFileUrlResolver(datasets);
  const { user } = useAuth();
  const needsPath = !!dataset && !isPrivateDataset(dataset) && !dataset.cog_path;
  const { data: fetchedPath } = useQuery({
    queryKey: ["datasets", dataset?.id, "cog-path", user?.id],
    queryFn: () => fetchPublicCogPath(dataset!.id),
    enabled: needsPath,
    staleTime: Infinity,
    retry: false,
  });
  if (!dataset) return { cogUrl: null, thumbnailUrl: null };
  return resolve(needsPath && fetchedPath ? { ...dataset, cog_path: fetchedPath } : dataset);
}
