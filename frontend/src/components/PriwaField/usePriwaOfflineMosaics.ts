import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "../../hooks/useAuthProvider";
import {
  downloadPriwaOfflineMosaics,
  loadPriwaOfflineMosaics,
  readPriwaOfflineMosaicFile,
  removePriwaOfflineMosaic,
  type IPriwaMosaicDownloadProgress,
  type IPriwaOfflineMosaic,
} from "./priwaOfflineMosaics";
import {
  planPriwaOfflineMosaics,
  validatePriwaMosaicPackage,
  type IPriwaOfflineMosaicPlan,
} from "./priwaOfflineMosaicPlan";
import type { IPriwaMosaic } from "./usePriwaMosaics";

export function usePriwaOfflineMosaics(
  projectId: string,
  onlineMosaics: IPriwaMosaic[],
) {
  const { user } = useAuth();
  const userId = user?.id;
  const [stored, setStored] = useState<{
    scope: string;
    entries: IPriwaOfflineMosaic[];
    files: Map<string, File>;
  } | null>(null);
  const [plans, setPlans] = useState<IPriwaOfflineMosaicPlan[]>([]);
  const [progress, setProgress] = useState<IPriwaMosaicDownloadProgress | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const controller = useRef<AbortController | null>(null);
  const scope = `${userId}:${projectId}`;

  const refresh = useCallback(async () => {
    if (!userId || !projectId || !navigator.storage?.getDirectory) return;
    const entries = await loadPriwaOfflineMosaics(userId, projectId);
    const files = new Map<string, File>();
    await Promise.all(
      entries
        .filter((entry) => entry.available)
        .map(async (entry) => {
          files.set(
            entry.mosaic.id,
            await readPriwaOfflineMosaicFile(userId, projectId, entry),
          );
        }),
    );
    setStored({ scope: `${userId}:${projectId}`, entries, files });
    setPersistent(await navigator.storage.persisted());
  }, [projectId, userId]);

  useEffect(() => {
    setPlans([]);
    setError(null);
    setLibraryError(null);
    void refresh().catch((error: unknown) => {
      setStored({
        scope: `${userId}:${projectId}`,
        entries: [],
        files: new Map(),
      });
      setLibraryError(
        error instanceof Error
          ? error.message
          : "Offline-Dateien konnten nicht gelesen werden.",
      );
    });
    return () => controller.current?.abort();
  }, [projectId, refresh, userId]);

  const entries = useMemo(
    () => (stored?.scope === scope ? stored.entries : []),
    [scope, stored],
  );
  const mosaics = useMemo(() => {
    const combined = new Map(
      onlineMosaics.map((mosaic) => [mosaic.id, mosaic]),
    );
    entries
      .filter((entry) => entry.available)
      .forEach((entry) => {
        // A saved image and its footprint/date are one snapshot. Never label an
        // older local file with metadata from a replacement online image.
        combined.set(entry.mosaic.id, entry.mosaic);
      });
    return Array.from(combined.values()).map((mosaic) => ({
      ...mosaic,
      offlineFile:
        stored?.scope === scope ? stored.files.get(mosaic.id) : undefined,
    }));
  }, [entries, onlineMosaics, scope, stored]);

  const run = async (
    operation: (signal: AbortSignal) => Promise<void>,
    onError = setError,
  ) => {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    onError(null);
    try {
      await operation(abort.signal);
    } catch (error) {
      onError(
        abort.signal.aborted
          ? "Download abgebrochen. Bereits gespeicherte Befliegungen bleiben erhalten."
          : error instanceof Error
            ? error.message
            : "Offline-Download fehlgeschlagen.",
      );
    } finally {
      controller.current = null;
      setBusy(false);
      setProgress(null);
    }
  };

  return {
    mosaics,
    entries,
    plans,
    progress,
    error,
    libraryError,
    busy,
    persistent,
    isLoading:
      !!userId &&
      !!projectId &&
      !!navigator.storage?.getDirectory &&
      stored?.scope !== scope,
    supported: !!navigator.storage?.getDirectory && !!navigator.locks,
    plan: (selection: IPriwaMosaic[]) =>
      run(async (signal) => {
        setPlans([]);
        const nextPlans = await planPriwaOfflineMosaics(selection, signal);
        try {
          validatePriwaMosaicPackage([
            ...entries.filter(
              (entry) => !selection.some((item) => item.id === entry.mosaic.id),
            ),
            ...nextPlans,
          ]);
        } catch (error) {
          throw Object.assign(
            new Error(
              `${error instanceof Error ? error.message : "Speicherlimit erreicht."} Bitte gegebenenfalls eine gespeicherte Befliegung entfernen.`,
            ),
            { cause: error },
          );
        }
        setPlans(nextPlans);
      }),
    download: () =>
      run(async (signal) => {
        if (!userId) throw new Error("Bitte zuerst anmelden.");
        const result = await downloadPriwaOfflineMosaics(
          userId,
          projectId,
          plans,
          signal,
          setProgress,
        );
        setPersistent(result.persistent);
        setPlans([]);
        await refresh();
      }),
    remove: (mosaicId: string) =>
      run(async () => {
        if (!userId) return;
        await removePriwaOfflineMosaic(userId, projectId, mosaicId);
        await refresh();
      }, setLibraryError),
    cancel: () => controller.current?.abort(),
    clearPlan: () => setPlans([]),
  };
}

export type PriwaOfflineMosaicsState = ReturnType<
  typeof usePriwaOfflineMosaics
>;
