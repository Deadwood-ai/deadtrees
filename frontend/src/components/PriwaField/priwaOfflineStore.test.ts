import { beforeEach, describe, expect, it, vi } from "vitest";

const { storage } = vi.hoisted(() => ({
  storage: new Map<string, unknown>(),
}));

vi.mock("localforage", () => ({
  default: {
    createInstance: () => ({
      getItem: (key: string) => Promise.resolve(storage.get(key) ?? null),
      setItem: (key: string, value: unknown) => {
        storage.set(key, value);
        return Promise.resolve(value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
        return Promise.resolve();
      },
    }),
  },
}));

import {
  appendPriwaOfflineBasemapArea,
  loadPriwaOfflineBasemapAreas,
  savePriwaOfflineBasemapAreas,
  type IPriwaOfflineBasemapArea,
} from "./priwaOfflineStore";

const legacyArea: IPriwaOfflineBasemapArea = {
  id: "project-1:2026-08-31T12:00:00.000Z",
  projectId: "project-1",
  name: "Ausschnitt + Umgebung",
  extent3857: [909_000, 6_179_000, 911_000, 6_181_000],
  centerLonLat: [8.18, 48.45],
  zoom: 16,
  minZoom: 16,
  maxZoom: 20,
  tileCount: 5_000,
  cachedTileCount: 5_000,
  failedTileCount: 0,
  areaKm2: 1.8,
  status: "ready",
  createdAt: "2026-08-31T12:00:00.000Z",
  updatedAt: "2026-08-31T12:00:00.000Z",
};

describe("PRIWA offline store", () => {
  beforeEach(() => storage.clear());

  it("loads a legacy single basemap area as the first saved area", async () => {
    storage.set("basemap-area:project-1", legacyArea);

    await expect(loadPriwaOfflineBasemapAreas("project-1")).resolves.toEqual([
      legacyArea,
    ]);
  });

  it("persists every downloaded basemap area for a project", async () => {
    const secondArea = {
      ...legacyArea,
      id: "project-1:2026-08-31T13:00:00.000Z",
      createdAt: "2026-08-31T13:00:00.000Z",
      updatedAt: "2026-08-31T13:00:00.000Z",
    };

    await savePriwaOfflineBasemapAreas("project-1", [legacyArea, secondArea]);

    await expect(loadPriwaOfflineBasemapAreas("project-1")).resolves.toEqual([
      legacyArea,
      secondArea,
    ]);
  });

  it("appends against the latest stored areas instead of a stale caller snapshot", async () => {
    const secondArea = {
      ...legacyArea,
      id: "project-1:2026-08-31T13:00:00.000Z",
      createdAt: "2026-08-31T13:00:00.000Z",
      updatedAt: "2026-08-31T13:00:00.000Z",
    };
    storage.set("basemap-area:project-1", legacyArea);

    await expect(
      appendPriwaOfflineBasemapArea("project-1", secondArea),
    ).resolves.toEqual([legacyArea, secondArea]);
    await expect(loadPriwaOfflineBasemapAreas("project-1")).resolves.toEqual([
      legacyArea,
      secondArea,
    ]);
  });
});
