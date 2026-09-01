import { toLonLat } from "ol/proj";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  appendPriwaOfflineBasemapArea,
  clearPriwaOfflineBasemapAreas,
  loadPriwaOfflineBasemapAreas,
  savePriwaOfflineBasemapAreas,
  type IPriwaOfflineBasemapArea,
} from "./priwaOfflineStore";
import {
  buildPriwaBasemapTilePlan,
  cachePriwaBasemapTiles,
  clearPriwaBasemapTileCache,
  loadPriwaBasemapCachedTileUrls,
  PRIWA_BASEMAP_CACHE_VERSION,
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

const getCachedAreaState = (
  area: IPriwaOfflineBasemapArea,
  cachedTileUrls: Set<string>,
) => {
  const plan = buildPriwaBasemapTilePlan(area.extent3857);
  const cachedTileCount = plan.urls.reduce(
    (count, url) => count + (cachedTileUrls.has(new URL(url).href) ? 1 : 0),
    0,
  );
  const isReady =
    area.cacheVersion === PRIWA_BASEMAP_CACHE_VERSION &&
    plan.urls.length > 0 &&
    cachedTileCount === plan.urls.length;

  return { cachedTileCount, isReady, plan };
};

export function usePriwaOfflineBasemap(projectId: string | null | undefined) {
  const [areas, setAreas] = useState<IPriwaOfflineBasemapArea[]>([]);
  const [readyAreaIds, setReadyAreaIds] = useState<string[]>([]);
  const [isCacheAuditComplete, setCacheAuditComplete] = useState(false);
  const areasRevisionRef = useRef(0);
  const [cacheState, setCacheState] =
    useState<IPriwaBasemapCacheState>(initialCacheState);

  useEffect(() => {
    let isMounted = true;

    const loadAreas = async () => {
      if (!projectId) {
        setAreas([]);
        setReadyAreaIds([]);
        setCacheAuditComplete(true);
        return;
      }

      const revision = areasRevisionRef.current;
      const storedAreas = await loadPriwaOfflineBasemapAreas(projectId);
      const cachedTileUrls = await loadPriwaBasemapCachedTileUrls(projectId);
      if (isMounted && revision === areasRevisionRef.current) {
        setAreas(storedAreas);
        setReadyAreaIds(
          storedAreas
            .filter((area) => getCachedAreaState(area, cachedTileUrls).isReady)
            .map((area) => area.id),
        );
        setCacheAuditComplete(true);
      }
    };

    setCacheAuditComplete(false);
    void loadAreas().catch((error) => {
      if (!isMounted) return;
      setReadyAreaIds([]);
      setCacheAuditComplete(true);
      setCacheState((currentState) => ({
        ...currentState,
        errorMessage: getErrorMessage(error),
      }));
    });

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
          cacheVersion: PRIWA_BASEMAP_CACHE_VERSION,
          createdAt: now,
          updatedAt: now,
        };

        const nextAreas = await appendPriwaOfflineBasemapArea(
          projectId,
          nextArea,
        );
        areasRevisionRef.current += 1;
        setAreas(nextAreas);
        setReadyAreaIds((currentAreaIds) =>
          result.failed === 0
            ? [...new Set([...currentAreaIds, nextArea.id])]
            : currentAreaIds,
        );
        setCacheAuditComplete(true);
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
    setReadyAreaIds([]);
    setCacheAuditComplete(true);
    setCacheState(initialCacheState);
  }, [projectId]);

  const refreshAreas = useCallback(async () => {
    if (!projectId || areas.length === 0) return;

    const plans = areas.map((area) =>
      buildPriwaBasemapTilePlan(area.extent3857),
    );
    plans.forEach(validatePriwaBasemapTilePlan);
    const urls = [...new Set(plans.flatMap((plan) => plan.urls))];
    setCacheAuditComplete(false);
    setCacheState({
      isCaching: true,
      cached: 0,
      failed: 0,
      total: urls.length,
      errorMessage: null,
    });

    try {
      const result = await cachePriwaBasemapTiles(
        projectId,
        urls,
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
      const cachedTileUrls = await loadPriwaBasemapCachedTileUrls(projectId);
      const now = new Date().toISOString();
      const nextAreas = areas.map((area) => {
        const { cachedTileCount, plan } = getCachedAreaState(
          { ...area, cacheVersion: PRIWA_BASEMAP_CACHE_VERSION },
          cachedTileUrls,
        );
        const failedTileCount = plan.urls.length - cachedTileCount;
        return {
          ...area,
          cacheVersion: PRIWA_BASEMAP_CACHE_VERSION,
          cachedTileCount,
          failedTileCount,
          status:
            failedTileCount === 0 ? ("ready" as const) : ("failed" as const),
          updatedAt: now,
        };
      });
      await savePriwaOfflineBasemapAreas(projectId, nextAreas);
      areasRevisionRef.current += 1;
      setAreas(nextAreas);
      setReadyAreaIds(
        nextAreas
          .filter((area) => getCachedAreaState(area, cachedTileUrls).isReady)
          .map((area) => area.id),
      );
      setCacheAuditComplete(true);
      setCacheState({
        isCaching: false,
        cached: result.cached,
        failed: result.failed,
        total: urls.length,
        errorMessage:
          result.failed > 0 ? `${result.failed} Kacheln fehlgeschlagen` : null,
      });
    } catch (error) {
      setCacheAuditComplete(true);
      setCacheState((currentState) => ({
        ...currentState,
        isCaching: false,
        errorMessage: getErrorMessage(error),
      }));
      throw error;
    }
  }, [areas, projectId]);

  const readyAreaIdSet = new Set(readyAreaIds);
  const readyAreas = areas.filter((area) => readyAreaIdSet.has(area.id));

  return {
    areas,
    readyAreas,
    needsRefresh:
      isCacheAuditComplete &&
      areas.some((area) => !readyAreaIdSet.has(area.id)),
    isCacheAuditComplete,
    cacheState,
    cacheCurrentMapArea,
    clearAreas,
    refreshAreas,
    isSupported:
      typeof globalThis !== "undefined" &&
      "caches" in globalThis &&
      "fetch" in globalThis,
  };
}
