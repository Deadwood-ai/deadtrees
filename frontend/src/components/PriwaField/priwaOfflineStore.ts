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

export interface IPriwaOfflineBasemapArea {
  id: string;
  projectId: string;
  name: string;
  extent3857: [number, number, number, number];
  centerLonLat: [number, number];
  zoom: number;
  minZoom: number;
  maxZoom: number;
  tileCount: number;
  cachedTileCount: number;
  failedTileCount: number;
  areaKm2: number;
  status: "ready" | "failed";
  createdAt: string;
  updatedAt: string;
}

const priwaOfflineStore = localforage.createInstance({
  name: "deadtrees-priwa-field",
  storeName: "offline",
});

const pointsKey = (projectId: string) => `points:${projectId}`;
const queueKey = (projectId: string, userId: string) =>
  `sync-queue:${projectId}:${userId}`;
const membershipsKey = (userId: string) => `memberships:${userId}`;
const basemapAreaKey = (projectId: string) => `basemap-area:${projectId}`;

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

export const loadPriwaOfflineBasemapArea = async (projectId: string) =>
  await priwaOfflineStore.getItem<IPriwaOfflineBasemapArea>(
    basemapAreaKey(projectId),
  );

export const savePriwaOfflineBasemapArea = async (
  projectId: string,
  area: IPriwaOfflineBasemapArea,
) => {
  await priwaOfflineStore.setItem(basemapAreaKey(projectId), area);
};

export const clearPriwaOfflineBasemapArea = async (projectId: string) => {
  await priwaOfflineStore.removeItem(basemapAreaKey(projectId));
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
