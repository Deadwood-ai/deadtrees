import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "../../hooks/useAuthProvider";
import { usePriwaOfflineStatus } from "./usePriwaOfflineStatus";
import type { IPriwaPoint, PriwaPointSyncOperation } from "./types";
import {
  createPriwaQueuedMutation,
  loadCachedPriwaPoints,
  loadPriwaSyncQueue,
  saveCachedPriwaPoints,
  savePriwaSyncQueue,
  type IPriwaQueuedMutation,
} from "./priwaOfflineStore";
import {
  coalescePriwaQueuedMutation,
  getPriwaSyncSummary,
  mergePriwaOfflinePoints,
  stripPriwaPointSyncState,
} from "./priwaOfflineSync";
import {
  fetchPriwaKaeferbaeume,
  priwaPointsQueryKey,
  softDeletePriwaKaeferbaum,
  upsertPriwaKaeferbaum,
} from "./usePriwaKaeferbaeume";

const upsertLocalPoint = (points: IPriwaPoint[], point: IPriwaPoint) => {
  const syncedPoint = stripPriwaPointSyncState(point);
  return [
    syncedPoint,
    ...points.filter((existingPoint) => existingPoint.id !== point.id),
  ].sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
};

const removeLocalPoint = (points: IPriwaPoint[], pointId: string) =>
  points.filter((point) => point.id !== pointId);

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "PRIWA Synchronisation fehlgeschlagen.";

export function usePriwaOfflineKaeferbaeume(
  projectId: string | null | undefined,
) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { isOnline } = usePriwaOfflineStatus();
  const userId = user?.id ?? null;
  const [cachedPoints, setCachedPoints] = useState<IPriwaPoint[]>([]);
  const [queue, setQueue] = useState<IPriwaQueuedMutation[]>([]);
  const [isLoadingOfflineState, setLoadingOfflineState] = useState(false);
  const [isSyncingQueue, setSyncingQueue] = useState(false);
  const syncPromiseRef = useRef<Promise<void> | null>(null);

  const pointsQuery = useQuery({
    queryKey: priwaPointsQueryKey(projectId),
    enabled: !!projectId && isOnline,
    queryFn: async () => {
      if (!projectId) return [];
      return fetchPriwaKaeferbaeume(projectId);
    },
    staleTime: 30 * 1000,
  });

  useEffect(() => {
    let isMounted = true;

    const loadOfflineState = async () => {
      if (!projectId || !userId) {
        setCachedPoints([]);
        setQueue([]);
        return;
      }

      setLoadingOfflineState(true);
      try {
        const [nextCachedPoints, nextQueue] = await Promise.all([
          loadCachedPriwaPoints(projectId),
          loadPriwaSyncQueue(projectId, userId),
        ]);

        if (!isMounted) return;

        setCachedPoints(nextCachedPoints);
        setQueue(nextQueue);
      } finally {
        if (isMounted) {
          setLoadingOfflineState(false);
        }
      }
    };

    void loadOfflineState();

    return () => {
      isMounted = false;
    };
  }, [projectId, userId]);

  useEffect(() => {
    if (!projectId || !pointsQuery.data) return;

    const syncedPoints = pointsQuery.data.map(stripPriwaPointSyncState);
    setCachedPoints(syncedPoints);
    void saveCachedPriwaPoints(projectId, syncedPoints);
  }, [pointsQuery.data, projectId]);

  const persistQueue = useCallback(
    async (nextQueue: IPriwaQueuedMutation[]) => {
      if (!projectId || !userId) return;

      setQueue(nextQueue);
      await savePriwaSyncQueue(projectId, userId, nextQueue);
    },
    [projectId, userId],
  );

  const syncQueue = useCallback(async () => {
    if (!projectId || !userId || !isOnline) return;

    if (syncPromiseRef.current) {
      await syncPromiseRef.current;
      return;
    }

    syncPromiseRef.current = (async () => {
      setSyncingQueue(true);
      let currentQueue = await loadPriwaSyncQueue(projectId, userId);

      for (const mutation of currentQueue) {
        const syncingMutation = {
          ...mutation,
          status: "syncing" as const,
          retryCount: mutation.retryCount + 1,
          lastError: undefined,
        };
        currentQueue = currentQueue.map((item) =>
          item.id === mutation.id ? syncingMutation : item,
        );
        await persistQueue(currentQueue);

        try {
          if (syncingMutation.type === "delete") {
            await softDeletePriwaKaeferbaum(
              syncingMutation.pointId,
              syncingMutation.updatedAt,
            );
            setCachedPoints((points) =>
              removeLocalPoint(points, syncingMutation.pointId),
            );
          } else if (syncingMutation.point) {
            await upsertPriwaKaeferbaum(projectId, syncingMutation.point);
            setCachedPoints((points) =>
              upsertLocalPoint(points, syncingMutation.point as IPriwaPoint),
            );
          }

          currentQueue = currentQueue.filter(
            (item) => item.id !== syncingMutation.id,
          );
          await persistQueue(currentQueue);
        } catch (error) {
          currentQueue = currentQueue.map((item) =>
            item.id === syncingMutation.id
              ? {
                  ...syncingMutation,
                  status: "failed" as const,
                  lastError: getErrorMessage(error),
                }
              : item,
          );
          await persistQueue(currentQueue);
          break;
        }
      }

      if (currentQueue.length === 0) {
        await queryClient.invalidateQueries({
          queryKey: priwaPointsQueryKey(projectId),
        });
      }
    })().finally(() => {
      setSyncingQueue(false);
      syncPromiseRef.current = null;
    });

    await syncPromiseRef.current;
  }, [isOnline, persistQueue, projectId, queryClient, userId]);

  const enqueueMutation = useCallback(
    async (
      type: PriwaPointSyncOperation,
      pointId: string,
      point?: IPriwaPoint,
    ) => {
      if (!projectId || !userId) {
        throw new Error("PRIWA project membership is required.");
      }

      const mutation = createPriwaQueuedMutation({
        projectId,
        userId,
        type,
        point,
        pointId,
      });
      const [currentQueue, currentCachedPoints] = await Promise.all([
        loadPriwaSyncQueue(projectId, userId),
        loadCachedPriwaPoints(projectId),
      ]);
      const nextQueue = coalescePriwaQueuedMutation(currentQueue, mutation);

      if (type === "delete") {
        const nextCachedPoints = removeLocalPoint(currentCachedPoints, pointId);
        setCachedPoints(nextCachedPoints);
        await saveCachedPriwaPoints(projectId, nextCachedPoints);
      } else if (point) {
        const nextCachedPoints = upsertLocalPoint(currentCachedPoints, point);
        setCachedPoints(nextCachedPoints);
        await saveCachedPriwaPoints(projectId, nextCachedPoints);
      }

      await persistQueue(nextQueue);

      if (isOnline) {
        void syncQueue();
      }
    },
    [isOnline, persistQueue, projectId, syncQueue, userId],
  );

  useEffect(() => {
    if (!isOnline || queue.length === 0) return;
    void syncQueue();
  }, [isOnline, queue.length, syncQueue]);

  const points = useMemo(
    () =>
      mergePriwaOfflinePoints(
        pointsQuery.data ?? cachedPoints,
        queue,
      ),
    [cachedPoints, pointsQuery.data, queue],
  );
  const syncSummary = useMemo(() => getPriwaSyncSummary(queue), [queue]);
  const hasCachedPoints = cachedPoints.length > 0;

  return {
    points,
    isLoading:
      isLoadingOfflineState ||
      (pointsQuery.isLoading && !hasCachedPoints && queue.length === 0),
    isRefetching: pointsQuery.isRefetching || isSyncingQueue,
    error: hasCachedPoints ? null : pointsQuery.error,
    createPoint: (point: IPriwaPoint) =>
      enqueueMutation("create", point.id, point),
    updatePoint: (point: IPriwaPoint) =>
      enqueueMutation("update", point.id, point),
    deletePoint: (pointId: string) => enqueueMutation("delete", pointId),
    isSaving: isSyncingQueue,
    syncSummary,
    syncNow: syncQueue,
  };
}
