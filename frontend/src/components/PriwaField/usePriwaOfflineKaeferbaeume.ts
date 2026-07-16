import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "../../hooks/useAuthProvider";
import { usePriwaOfflineStatus } from "./usePriwaOfflineStatus";
import type { IPriwaPoint, PriwaPointSyncOperation } from "./types";
import {
  createPriwaQueuedMutation,
  loadCachedPriwaPoints,
  loadPriwaSyncQueue,
  saveCachedPriwaPoints,
  type IPriwaQueuedMutation,
} from "./priwaOfflineStore";
import {
  coalescePriwaQueuedMutation,
  getPriwaSyncSummary,
  mergePriwaOfflinePoints,
  stripPriwaPointSyncState,
} from "./priwaOfflineSync";
import { priwaBefallsgruppenQueryKey } from "./usePriwaBefallsgruppen";
import {
  fetchPriwaKaeferbaeume,
  priwaPointsQueryKey,
} from "./usePriwaKaeferbaeume";
import { usePriwaSyncQueueRunner } from "./usePriwaSyncQueueRunner";

const upsertLocalPoint = (points: IPriwaPoint[], point: IPriwaPoint) => {
  const syncedPoint = stripPriwaPointSyncState(point);
  return [
    syncedPoint,
    ...points.filter((existingPoint) => existingPoint.id !== point.id),
  ].sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
};

const removeLocalPoint = (points: IPriwaPoint[], pointId: string) =>
  points.filter((point) => point.id !== pointId);

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
      } catch (error) {
        console.error("Failed to load PRIWA offline state", error);
        if (!isMounted) return;

        setCachedPoints([]);
        setQueue([]);
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

  const onPointSynced = useCallback((point: IPriwaPoint) => {
    setCachedPoints((points) => upsertLocalPoint(points, point));
  }, []);

  const onPointDeleted = useCallback((pointId: string) => {
    setCachedPoints((points) => removeLocalPoint(points, pointId));
  }, []);

  const onQueueDrained = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: priwaPointsQueryKey(projectId),
      }),
      queryClient.invalidateQueries({
        queryKey: priwaBefallsgruppenQueryKey(projectId),
      }),
    ]);
  }, [projectId, queryClient]);

  const { isSyncingQueue, syncQueue, updateStoredQueue } =
    usePriwaSyncQueueRunner({
      projectId,
      userId,
      isOnline,
      onQueueUpdated: setQueue,
      onPointSynced,
      onPointDeleted,
      onQueueDrained,
    });

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
      const currentCachedPoints = await loadCachedPriwaPoints(projectId);

      if (type === "delete") {
        const nextCachedPoints = removeLocalPoint(currentCachedPoints, pointId);
        setCachedPoints(nextCachedPoints);
        await saveCachedPriwaPoints(projectId, nextCachedPoints);
      } else if (point) {
        const nextCachedPoints = upsertLocalPoint(currentCachedPoints, point);
        setCachedPoints(nextCachedPoints);
        await saveCachedPriwaPoints(projectId, nextCachedPoints);
      }

      await updateStoredQueue((currentQueue) =>
        coalescePriwaQueuedMutation(currentQueue, mutation),
      );

      if (isOnline) {
        void syncQueue();
      }
    },
    [isOnline, projectId, syncQueue, updateStoredQueue, userId],
  );

  useEffect(() => {
    if (!isOnline || queue.length === 0) return;
    void syncQueue();
  }, [isOnline, queue.length, syncQueue]);

  const points = useMemo(
    () =>
      mergePriwaOfflinePoints(
        cachedPoints.length > 0 ? cachedPoints : (pointsQuery.data ?? []),
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
