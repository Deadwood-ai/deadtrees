import type { Map } from "ol";
import { toLonLat } from "ol/proj";
import { useCallback, useEffect, useState } from "react";

import {
  clearPriwaOfflineBasemapArea,
  loadPriwaOfflineBasemapArea,
  savePriwaOfflineBasemapArea,
  type IPriwaOfflineBasemapArea,
} from "./priwaOfflineStore";
import {
  buildPriwaBasemapTilePlan,
  cachePriwaBasemapTiles,
  clearPriwaBasemapTileCache,
  validatePriwaBasemapTilePlan,
} from "./priwaOfflineBasemap";

interface IPriwaBasemapCacheState {
  isCaching: boolean;
  cached: number;
  failed: number;
  total: number;
  errorMessage: string | null;
}

const initialCacheState: IPriwaBasemapCacheState = {
  isCaching: false,
  cached: 0,
  failed: 0,
  total: 0,
  errorMessage: null,
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Basiskarte konnte nicht offline gespeichert werden.";

const getMapExtent = (map: Map) => {
  const size = map.getSize();
  if (!size) throw new Error("Die Karte ist noch nicht bereit.");

  return map.getView().calculateExtent(size) as [
    number,
    number,
    number,
    number,
  ];
};

export function usePriwaOfflineBasemap(projectId: string | null | undefined) {
  const [area, setArea] = useState<IPriwaOfflineBasemapArea | null>(null);
  const [cacheState, setCacheState] =
    useState<IPriwaBasemapCacheState>(initialCacheState);

  useEffect(() => {
    let isMounted = true;

    const loadArea = async () => {
      if (!projectId) {
        setArea(null);
        return;
      }

      const storedArea = await loadPriwaOfflineBasemapArea(projectId);
      if (isMounted) {
        setArea(storedArea ?? null);
      }
    };

    void loadArea();

    return () => {
      isMounted = false;
    };
  }, [projectId]);

  const cacheCurrentMapArea = useCallback(
    async (map: Map | null) => {
      if (!projectId) {
        throw new Error("PRIWA Projekt ist noch nicht bereit.");
      }
      if (!map) {
        throw new Error("Die Karte ist noch nicht bereit.");
      }

      const extent3857 = getMapExtent(map);
      const zoom = map.getView().getZoom() ?? 18;
      const plan = buildPriwaBasemapTilePlan(extent3857, zoom);
      validatePriwaBasemapTilePlan(plan);

      const center = toLonLat(
        map.getView().getCenter() ?? [
          (extent3857[0] + extent3857[2]) / 2,
          (extent3857[1] + extent3857[3]) / 2,
        ],
      ) as [number, number];
      const now = new Date().toISOString();

      setCacheState({
        isCaching: true,
        cached: 0,
        failed: 0,
        total: plan.tileCount,
        errorMessage: null,
      });

      try {
        const result = await cachePriwaBasemapTiles(plan.urls, (progress) => {
          setCacheState({
            isCaching: true,
            cached: progress.cached,
            failed: progress.failed,
            total: progress.total,
            errorMessage: null,
          });
        });

        const nextArea: IPriwaOfflineBasemapArea = {
          id: `${projectId}:${now}`,
          projectId,
          name: "Kartenausschnitt",
          extent3857,
          centerLonLat: center,
          zoom,
          minZoom: plan.minZoom,
          maxZoom: plan.maxZoom,
          tileCount: plan.tileCount,
          cachedTileCount: result.cached,
          failedTileCount: result.failed,
          areaKm2: plan.areaKm2,
          status: result.failed > 0 ? "failed" : "ready",
          createdAt: area?.createdAt ?? now,
          updatedAt: now,
        };

        await savePriwaOfflineBasemapArea(projectId, nextArea);
        setArea(nextArea);
        setCacheState({
          isCaching: false,
          cached: result.cached,
          failed: result.failed,
          total: plan.tileCount,
          errorMessage:
            result.failed > 0
              ? `${result.failed} Kacheln fehlgeschlagen`
              : null,
        });

        return nextArea;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        setCacheState((currentState) => ({
          ...currentState,
          isCaching: false,
          errorMessage,
        }));
        throw error;
      }
    },
    [area?.createdAt, projectId],
  );

  const clearArea = useCallback(async () => {
    if (!projectId) return;

    await clearPriwaOfflineBasemapArea(projectId);
    await clearPriwaBasemapTileCache();
    setArea(null);
    setCacheState(initialCacheState);
  }, [projectId]);

  return {
    area,
    cacheState,
    cacheCurrentMapArea,
    clearArea,
    isSupported:
      typeof globalThis !== "undefined" &&
      "caches" in globalThis &&
      "fetch" in globalThis,
  };
}
