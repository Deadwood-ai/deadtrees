import type {
  IPriwaPoint,
  PriwaPointSyncOperation,
  PriwaPointSyncStatus,
} from "./types";
import type {
  IPriwaQueuedMutation,
  PriwaQueuedMutationStatus,
} from "./priwaOfflineStore";

export interface IPriwaSyncSummary {
  pending: number;
  syncing: number;
  failed: number;
  total: number;
}

export const stripPriwaPointSyncState = (point: IPriwaPoint): IPriwaPoint => {
  const { syncStatus, syncOperation, syncError, ...syncedPoint } = point;
  void syncStatus;
  void syncOperation;
  void syncError;
  return syncedPoint;
};

const toPointSyncStatus = (
  status: PriwaQueuedMutationStatus,
): PriwaPointSyncStatus => (status === "failed" ? "failed" : status);

export const getPriwaSyncSummary = (
  queue: IPriwaQueuedMutation[],
): IPriwaSyncSummary => {
  const pending = queue.filter((item) => item.status === "pending").length;
  const syncing = queue.filter((item) => item.status === "syncing").length;
  const failed = queue.filter((item) => item.status === "failed").length;

  return {
    pending,
    syncing,
    failed,
    total: pending + syncing + failed,
  };
};

export const coalescePriwaQueuedMutation = (
  queue: IPriwaQueuedMutation[],
  mutation: IPriwaQueuedMutation,
) => {
  const existing = queue.find((item) => item.pointId === mutation.pointId);
  const remaining = queue.filter((item) => item.pointId !== mutation.pointId);

  if (existing?.type === "create" && mutation.type === "delete") {
    return remaining;
  }

  const type: PriwaPointSyncOperation =
    existing?.type === "create" && mutation.type === "update"
      ? "create"
      : mutation.type;

  return [
    ...remaining,
    {
      ...existing,
      ...mutation,
      type,
      queuedAt: existing?.queuedAt ?? mutation.queuedAt,
      retryCount: existing?.retryCount ?? 0,
      status: "pending" as const,
      lastError: undefined,
    },
  ];
};

export const mergePriwaOfflinePoints = (
  points: IPriwaPoint[],
  queue: IPriwaQueuedMutation[],
): IPriwaPoint[] => {
  const merged = new Map<string, IPriwaPoint>(
    points.map((point) => [
      point.id,
      {
        ...stripPriwaPointSyncState(point),
        syncStatus: "synced" as const,
      },
    ]),
  );

  queue.forEach((mutation) => {
    if (mutation.type === "delete") {
      if (mutation.status === "failed") {
        const point = merged.get(mutation.pointId);
        if (point) {
          merged.set(mutation.pointId, {
            ...point,
            syncStatus: "failed",
            syncOperation: "delete",
            syncError: mutation.lastError,
          });
        }
        return;
      }
      merged.delete(mutation.pointId);
      return;
    }

    if (!mutation.point) return;

    merged.set(mutation.pointId, {
      ...stripPriwaPointSyncState(mutation.point),
      syncStatus: toPointSyncStatus(mutation.status),
      syncOperation: mutation.type,
      syncError: mutation.lastError,
    });
  });

  return Array.from(merged.values()).sort((left, right) =>
    right.capturedAt.localeCompare(left.capturedAt),
  );
};
