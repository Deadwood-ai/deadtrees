import localforage from "localforage";

import type { IPriwaPoint, PriwaPointSyncOperation } from "./types";

export type PriwaQueuedMutationStatus = "pending" | "syncing" | "failed";

export interface IPriwaCachedProjectMembership {
  projectId: string;
  projectName: string;
  projectSlug: string;
  role: "field_user" | "coordinator" | "admin";
}

export interface IPriwaQueuedMutation {
  id: string;
  projectId: string;
  userId: string;
  pointId: string;
  type: PriwaPointSyncOperation;
  point?: IPriwaPoint;
  queuedAt: string;
  updatedAt: string;
  retryCount: number;
  status: PriwaQueuedMutationStatus;
  lastError?: string;
}

const priwaOfflineStore = localforage.createInstance({
  name: "deadtrees-priwa-field",
  storeName: "offline",
});

const pointsKey = (projectId: string) => `points:${projectId}`;
const queueKey = (projectId: string, userId: string) =>
  `sync-queue:${projectId}:${userId}`;
const membershipsKey = (userId: string) => `memberships:${userId}`;

export const loadCachedPriwaPoints = async (projectId: string) =>
  (await priwaOfflineStore.getItem<IPriwaPoint[]>(pointsKey(projectId))) ?? [];

export const saveCachedPriwaPoints = async (
  projectId: string,
  points: IPriwaPoint[],
) => {
  await priwaOfflineStore.setItem(pointsKey(projectId), points);
};

export const loadPriwaSyncQueue = async (projectId: string, userId: string) =>
  (await priwaOfflineStore.getItem<IPriwaQueuedMutation[]>(
    queueKey(projectId, userId),
  )) ?? [];

export const savePriwaSyncQueue = async (
  projectId: string,
  userId: string,
  queue: IPriwaQueuedMutation[],
) => {
  await priwaOfflineStore.setItem(queueKey(projectId, userId), queue);
};

export const loadCachedPriwaMemberships = async (userId: string) =>
  (await priwaOfflineStore.getItem<IPriwaCachedProjectMembership[]>(
    membershipsKey(userId),
  )) ?? [];

export const saveCachedPriwaMemberships = async (
  userId: string,
  memberships: IPriwaCachedProjectMembership[],
) => {
  await priwaOfflineStore.setItem(membershipsKey(userId), memberships);
};

export const createPriwaQueuedMutation = ({
  projectId,
  userId,
  type,
  point,
  pointId,
}: {
  projectId: string;
  userId: string;
  type: PriwaPointSyncOperation;
  point?: IPriwaPoint;
  pointId: string;
}): IPriwaQueuedMutation => {
  const now = new Date().toISOString();
  return {
    id: `${projectId}:${userId}:${pointId}`,
    projectId,
    userId,
    pointId,
    type,
    point,
    queuedAt: now,
    updatedAt: now,
    retryCount: 0,
    status: "pending",
  };
};
