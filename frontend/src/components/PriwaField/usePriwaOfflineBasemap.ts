import { toLonLat } from "ol/proj";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  appendPriwaOfflineBasemapArea,
  clearPriwaOfflineBasemapAreas,
  loadPriwaOfflineBasemapAreas,
  type IPriwaOfflineBasemapArea,
} from "./priwaOfflineStore";
import {
  cachePriwaBasemapTiles,
  clearPriwaBasemapTileCache,
  validatePriwaBasemapTilePlan,
} from "./priwaOfflineBasemap";
import type { IPriwaOfflineSelectionPlan } from "./usePriwaOfflineSelectionPlan";

export interface IPriwaBasemapCacheState {
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

export function usePriwaOfflineBasemap(projectId: string | null | undefined) {
  const [areas, setAreas] = useState<IPriwaOfflineBasemapArea[]>([]);
  const areasRevisionRef = useRef(0);
  const [cacheState, setCacheState] =
    useState<IPriwaBasemapCacheState>(initialCacheState);

  useEffect(() => {
    let isMounted = true;

    const loadAreas = async () => {
      if (!projectId) {
        setAreas([]);
        return;
      }

      const revision = areasRevisionRef.current;
      const storedAreas = await loadPriwaOfflineBasemapAreas(projectId);
      if (isMounted && revision === areasRevisionRef.current) {
        setAreas(storedAreas);
      }
    };

    void loadAreas();

    return () => {
      isMounted = false;
    };
  }, [projectId]);

  const cacheCurrentMapArea = useCallback(
    async (plan: IPriwaOfflineSelectionPlan) => {
      if (!projectId) {
        throw new Error("PRIWA Projekt ist noch nicht bereit.");
      }
      validatePriwaBasemapTilePlan(plan);

      const center = toLonLat([
        (plan.extent3857[0] + plan.extent3857[2]) / 2,
        (plan.extent3857[1] + plan.extent3857[3]) / 2,
      ]) as [number, number];
      const now = new Date().toISOString();

      setCacheState({
        isCaching: true,
        cached: 0,
        failed: 0,
        total: plan.tileCount,
        errorMessage: null,
      });

      try {
        const result = await cachePriwaBasemapTiles(
          projectId,
          plan.urls,
          (progress) => {
            setCacheState({
              isCaching: true,
              cached: progress.cached,
              failed: progress.failed,
              total: progress.total,
              errorMessage: null,
            });
          },
        );

        const nextArea: IPriwaOfflineBasemapArea = {
          id: `${projectId}:${now}`,
          projectId,
          name: "Offline-Bereich",
          extent3857: plan.extent3857,
          centerLonLat: center,
          zoom: plan.selectionZoom,
          minZoom: plan.minZoom,
          maxZoom: plan.maxZoom,
          tileCount: plan.tileCount,
          cachedTileCount: result.cached,
          failedTileCount: result.failed,
          areaKm2: plan.areaKm2,
          status: result.failed > 0 ? "failed" : "ready",
          createdAt: now,
          updatedAt: now,
        };

        const nextAreas = await appendPriwaOfflineBasemapArea(
          projectId,
          nextArea,
        );
        areasRevisionRef.current += 1;
        setAreas(nextAreas);
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
    [projectId],
  );

  const clearAreas = useCallback(async () => {
    if (!projectId) return;

    areasRevisionRef.current += 1;
    await clearPriwaOfflineBasemapAreas(projectId);
    await clearPriwaBasemapTileCache(projectId);
    setAreas([]);
    setCacheState(initialCacheState);
  }, [projectId]);

  return {
    areas,
    cacheState,
    cacheCurrentMapArea,
    clearAreas,
    isSupported:
      typeof globalThis !== "undefined" &&
      "caches" in globalThis &&
      "fetch" in globalThis,
  };
}
