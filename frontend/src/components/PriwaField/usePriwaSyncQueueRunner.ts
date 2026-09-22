import { useCallback, useRef } from "react";

import {
  loadPriwaSyncQueue,
  type IPriwaQueuedMutation,
} from "./priwaOfflineStore";
import { updatePriwaSyncQueue } from "./priwaOfflineQueue";
import { recoverInterruptedPriwaMutations } from "./priwaOfflineSync";
import { runWithPriwaSyncLock } from "./priwaSyncLock";
import type { IPriwaPoint } from "./types";
import { syncPriwaObservation } from "./syncPriwaObservation";

const getErrorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "PRIWA Synchronisation fehlgeschlagen.";

const hasQueueWork = (queue: IPriwaQueuedMutation[]) =>
  queue.some((mutation) => mutation.status !== "syncing");

interface IPriwaSyncQueueRunnerOptions {
  projectId: string | null | undefined;
  userId: string | null;
  isOnline: boolean;
  onQueueUpdated: (queue: IPriwaQueuedMutation[]) => void;
  onPointSynced: (point: IPriwaPoint) => void;
  onPointDeleted: (pointId: string) => void;
  onSyncFinished: () => Promise<void>;
}

export function usePriwaSyncQueueRunner({
  projectId,
  userId,
  isOnline,
  onQueueUpdated,
  onPointSynced,
  onPointDeleted,
  onSyncFinished,
}: IPriwaSyncQueueRunnerOptions) {
  const syncPromiseRef = useRef<Promise<void> | null>(null);

  const updateStoredQueue = useCallback(
    async (
      updater: (queue: IPriwaQueuedMutation[]) => IPriwaQueuedMutation[],
    ) => {
      if (!projectId || !userId) return [];

      return updatePriwaSyncQueue(projectId, userId, updater, onQueueUpdated);
    },
    [onQueueUpdated, projectId, userId],
  );

  const syncQueue = useCallback(async () => {
    if (!projectId || !userId || !isOnline) return;

    if (syncPromiseRef.current) {
      await syncPromiseRef.current;
      const latestQueue = await loadPriwaSyncQueue(projectId, userId);
      if (hasQueueWork(latestQueue)) {
        await syncQueue();
      }
      return;
    }

    syncPromiseRef.current = runWithPriwaSyncLock(
      projectId,
      userId,
      async () => {
        await updateStoredQueue(recoverInterruptedPriwaMutations);
        const attempted = new Set<string>();
        const mutationKey = (item: IPriwaQueuedMutation) =>
          `${item.id}:${item.updatedAt}`;
        while (true) {
          const claim: { mutation?: IPriwaQueuedMutation } = {};
          await updateStoredQueue((queue) => {
            const mutation = queue.find(
              (item) =>
                item.status !== "syncing" && !attempted.has(mutationKey(item)),
            );
            if (!mutation) return queue;

            claim.mutation = {
              ...mutation,
              status: "syncing" as const,
              retryCount: mutation.retryCount + 1,
              attemptedUpdatedAts: Array.from(
                new Set([
                  ...(mutation.attemptedUpdatedAts ?? []),
                  mutation.updatedAt,
                ]),
              ),
              lastError: undefined,
            };
            return queue.map((item) =>
              item.id === mutation.id && item.updatedAt === mutation.updatedAt
                ? claim.mutation!
                : item,
            );
          });
          const syncingMutation = claim.mutation;

          if (!syncingMutation) break;

          attempted.add(mutationKey(syncingMutation));
          try {
            const serverUpdatedAt = await syncPriwaObservation(syncingMutation);
            if (syncingMutation.type === "delete") {
              onPointDeleted(syncingMutation.pointId);
            } else if (syncingMutation.point) {
              const point = syncingMutation.point;
              onPointSynced({ ...point, serverUpdatedAt });
            }

            await updateStoredQueue((queue) =>
              queue
                .filter(
                  (item) =>
                    item.id !== syncingMutation.id ||
                    item.updatedAt !== syncingMutation.updatedAt ||
                    item.status !== "syncing",
                )
                .map((item) =>
                  item.pointId === syncingMutation.pointId
                    ? {
                        ...item,
                        baseUpdatedAt: serverUpdatedAt,
                        attemptedUpdatedAts: [],
                        type:
                          item.type === "create"
                            ? ("update" as const)
                            : item.type,
                        point: item.point
                          ? { ...item.point, serverUpdatedAt }
                          : undefined,
                      }
                    : item,
                ),
            );
          } catch (error) {
            await updateStoredQueue((queue) =>
              queue.map((item) =>
                item.id === syncingMutation.id &&
                item.updatedAt === syncingMutation.updatedAt &&
                item.status === "syncing"
                  ? {
                      ...syncingMutation,
                      status: "failed" as const,
                      lastError: getErrorMessage(error),
                    }
                  : item,
              ),
            );
            // Retain the failed edit and let independent observations sync.
          }
        }
        await onSyncFinished();
      },
    ).finally(() => {
      syncPromiseRef.current = null;
    });

    await syncPromiseRef.current;
  }, [
    isOnline,
    onPointDeleted,
    onPointSynced,
    onSyncFinished,
    projectId,
    updateStoredQueue,
    userId,
  ]);

  return {
    syncQueue,
    updateStoredQueue,
  };
}
