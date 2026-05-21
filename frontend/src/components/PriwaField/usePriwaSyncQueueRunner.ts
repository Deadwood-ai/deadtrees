import { useCallback, useRef, useState } from "react";

import {
  loadPriwaSyncQueue,
  type IPriwaQueuedMutation,
} from "./priwaOfflineStore";
import { updatePriwaSyncQueue } from "./priwaOfflineQueue";
import type { IPriwaPoint } from "./types";
import {
  softDeletePriwaKaeferbaum,
  upsertPriwaKaeferbaum,
} from "./usePriwaKaeferbaeume";

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "PRIWA Synchronisation fehlgeschlagen.";

const hasQueueWork = (queue: IPriwaQueuedMutation[]) =>
  queue.some((mutation) => mutation.status !== "syncing");

interface IPriwaSyncQueueRunnerOptions {
  projectId: string | null | undefined;
  userId: string | null;
  isOnline: boolean;
  onQueueUpdated: (queue: IPriwaQueuedMutation[]) => void;
  onPointSynced: (point: IPriwaPoint) => void;
  onPointDeleted: (pointId: string) => void;
  onQueueDrained: () => Promise<void>;
}

export function usePriwaSyncQueueRunner({
  projectId,
  userId,
  isOnline,
  onQueueUpdated,
  onPointSynced,
  onPointDeleted,
  onQueueDrained,
}: IPriwaSyncQueueRunnerOptions) {
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const [isSyncingQueue, setSyncingQueue] = useState(false);

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

    syncPromiseRef.current = (async () => {
      setSyncingQueue(true);
      let shouldContinue = true;

      while (shouldContinue) {
        const currentQueue = await loadPriwaSyncQueue(projectId, userId);
        const mutation = currentQueue.find(
          (item) => item.status !== "syncing",
        );
        if (!mutation) {
          if (currentQueue.length === 0) {
            await onQueueDrained();
          }
          shouldContinue = false;
          break;
        }

        const syncingMutation = {
          ...mutation,
          status: "syncing" as const,
          retryCount: mutation.retryCount + 1,
          updatedAt: new Date().toISOString(),
          lastError: undefined,
        };
        await updateStoredQueue((queue) =>
          queue.map((item) =>
            item.id === mutation.id && item.updatedAt === mutation.updatedAt
              ? syncingMutation
              : item,
          ),
        );

        try {
          if (syncingMutation.type === "delete") {
            await softDeletePriwaKaeferbaum(
              syncingMutation.pointId,
              userId,
              syncingMutation.updatedAt,
            );
            onPointDeleted(syncingMutation.pointId);
          } else if (syncingMutation.point) {
            await upsertPriwaKaeferbaum(projectId, syncingMutation.point);
            onPointSynced(syncingMutation.point);
          }

          await updateStoredQueue((queue) =>
            queue.filter(
              (item) =>
                item.id !== syncingMutation.id ||
                item.updatedAt !== syncingMutation.updatedAt ||
                item.status !== "syncing",
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
          break;
        }
      }
    })().finally(() => {
      setSyncingQueue(false);
      syncPromiseRef.current = null;
    });

    await syncPromiseRef.current;
  }, [
    isOnline,
    onPointDeleted,
    onPointSynced,
    onQueueDrained,
    projectId,
    updateStoredQueue,
    userId,
  ]);

  return {
    isSyncingQueue,
    syncQueue,
    updateStoredQueue,
  };
}
