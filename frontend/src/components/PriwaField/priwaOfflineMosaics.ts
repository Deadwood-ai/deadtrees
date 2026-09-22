import { resolvePriwaCogUrl } from "./createPriwaCogLayer";
import {
  validatePriwaMosaicPackage,
  type IPriwaOfflineMosaicPlan,
} from "./priwaOfflineMosaicPlan";

export interface IPriwaOfflineMosaic extends IPriwaOfflineMosaicPlan {
  fileName: string;
  savedAt: string;
  available: boolean;
}
export interface IPriwaMosaicDownloadProgress {
  label: string;
  downloadedBytes: number;
  totalBytes: number;
}

const directoryName = (userId: string, projectId: string) =>
  `priwa-mosaics-${encodeURIComponent(userId)}-${encodeURIComponent(projectId)}`;

async function openDirectory(userId: string, projectId: string) {
  if (!userId || !projectId)
    throw new Error("Bitte zuerst im PRIWA-Projekt anmelden.");
  if (!navigator.storage?.getDirectory) {
    throw new Error(
      "Dieser Browser unterstützt keine vollständigen Offline-Befliegungen.",
    );
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(directoryName(userId, projectId), {
    create: true,
  });
}

async function readManifest(
  directory: FileSystemDirectoryHandle,
): Promise<IPriwaOfflineMosaic[]> {
  try {
    const handle = await directory.getFileHandle("manifest.json");
    return JSON.parse(await (await handle.getFile()).text());
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError")
      return [];
    throw error;
  }
}

async function writeManifest(
  directory: FileSystemDirectoryHandle,
  entries: IPriwaOfflineMosaic[],
) {
  const file = await directory.getFileHandle("manifest.json", { create: true });
  const writer = await file.createWritable();
  try {
    await writer.write(JSON.stringify(entries));
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
}

export async function loadPriwaOfflineMosaics(
  userId: string,
  projectId: string,
) {
  const directory = await openDirectory(userId, projectId);
  return Promise.all(
    (await readManifest(directory)).map(async (entry) => {
      try {
        const file = await (
          await directory.getFileHandle(entry.fileName)
        ).getFile();
        return { ...entry, available: file.size === entry.bytes };
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError"))
          throw error;
        return { ...entry, available: false };
      }
    }),
  );
}

export async function readPriwaOfflineMosaicFile(
  userId: string,
  projectId: string,
  entry: IPriwaOfflineMosaic,
) {
  const directory = await openDirectory(userId, projectId);
  const file = await (await directory.getFileHandle(entry.fileName)).getFile();
  if (file.size !== entry.bytes)
    throw new Error(
      "Die Offline-Befliegung ist unvollständig. Bitte erneut herunterladen.",
    );
  return file;
}

// The response is streamed to disk. Neither the full compressed file nor its
// decoded raster is materialized in memory during the download.
export async function streamPriwaMosaicFile(
  response: Response,
  writer: FileSystemWritableFileStream,
  bytes: number,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
) {
  if (response.status !== 200 || !response.body) {
    await writer.abort().catch(() => undefined);
    await response.body?.cancel();
    throw new Error(
      `Vollständige Befliegung nicht verfügbar (HTTP ${response.status}).`,
    );
  }
  const reader = response.body.getReader();
  let received = 0;
  let readTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          readTimeout = setTimeout(
            () =>
              reject(
                new Error(
                  "Seit 30 Sekunden keine Daten empfangen. Bitte Verbindung prüfen und erneut versuchen.",
                ),
              ),
            30_000,
          );
        }),
      ]);
      clearTimeout(readTimeout);
      if (done) break;
      received += value.byteLength;
      if (received > bytes)
        throw new Error(
          "Die Dateigröße hat sich geändert. Bitte die Auswahl erneut prüfen.",
        );
      await writer.write(value);
      onProgress(received);
    }
    signal.throwIfAborted();
    if (received !== bytes)
      throw new Error(
        "Der Download ist unvollständig. Bitte erneut versuchen.",
      );
    await writer.close();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await writer.abort().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(readTimeout);
    reader.releaseLock();
  }
}

export async function downloadPriwaOfflineMosaics(
  userId: string,
  projectId: string,
  plans: IPriwaOfflineMosaicPlan[],
  signal: AbortSignal,
  onProgress: (progress: IPriwaMosaicDownloadProgress) => void,
) {
  validatePriwaMosaicPackage(plans);
  if (plans.some(({ mosaic }) => mosaic.projectId !== projectId))
    throw new Error("Die Auswahl gehört zu einem anderen Projekt.");
  return navigator.locks.request(
    directoryName(userId, projectId),
    { signal },
    async () => {
      const directory = await openDirectory(userId, projectId);
      const oldEntries = await loadPriwaOfflineMosaics(userId, projectId);
      // A killed browser can leave an unpublished temporary file. Only remove
      // these while holding the download lock, never during another tab's write.
      const publishedFiles = new Set(oldEntries.map((entry) => entry.fileName));
      for await (const name of directory.keys()) {
        if (name.endsWith(".tif") && !publishedFiles.has(name))
          await directory.removeEntry(name);
      }
      const retained = oldEntries.filter(
        (entry) => !plans.some(({ mosaic }) => mosaic.id === entry.mosaic.id),
      );
      validatePriwaMosaicPackage([...retained, ...plans]);
      const totalBytes = plans.reduce((sum, plan) => sum + plan.bytes, 0);
      const estimate = await navigator.storage.estimate();
      if (
        estimate.quota !== undefined &&
        estimate.usage !== undefined &&
        estimate.quota - estimate.usage < totalBytes * 1.1
      ) {
        throw new Error(
          "Nicht genug freier Speicher. Bitte alte Offline-Befliegungen entfernen.",
        );
      }
      const persistent = await navigator.storage.persist().catch(() => false);
      const downloaded: IPriwaOfflineMosaic[] = [];
      const newFileNames: string[] = [];
      let completedBytes = 0;
      try {
        for (const plan of plans) {
          signal.throwIfAborted();
          onProgress({
            label: plan.mosaic.label,
            downloadedBytes: completedBytes,
            totalBytes,
          });
          const response = await fetch(resolvePriwaCogUrl(plan.mosaic.cogUrl), {
            cache: "no-store",
            signal,
          });
          if (
            (plan.etag && response.headers.get("ETag") !== plan.etag) ||
            (plan.lastModified &&
              response.headers.get("Last-Modified") !== plan.lastModified)
          ) {
            await response.body?.cancel();
            throw new Error(
              "Die Befliegung wurde geändert. Bitte die Auswahl erneut prüfen.",
            );
          }
          const fileName = `${crypto.randomUUID()}.tif`;
          newFileNames.push(fileName);
          const file = await directory.getFileHandle(fileName, {
            create: true,
          });
          await streamPriwaMosaicFile(
            response,
            await file.createWritable(),
            plan.bytes,
            signal,
            (received) =>
              onProgress({
                label: plan.mosaic.label,
                downloadedBytes: completedBytes + received,
                totalBytes,
              }),
          );
          if ((await file.getFile()).size !== plan.bytes)
            throw new Error("Die gespeicherte Befliegung ist unvollständig.");
          downloaded.push({
            ...plan,
            fileName,
            savedAt: new Date().toISOString(),
            available: true,
          });
          completedBytes += plan.bytes;
        }
        signal.throwIfAborted();
        // Publish only after every source byte has been written and checked.
        // Interrupted replacement never removes a previously completed package.
        await writeManifest(directory, [...retained, ...downloaded]);
      } catch (error) {
        await Promise.all(
          newFileNames.map((name) =>
            directory.removeEntry(name).catch(() => undefined),
          ),
        );
        throw error;
      }
      await Promise.all(
        oldEntries
          .filter((entry) => !retained.includes(entry))
          .map((entry) =>
            directory.removeEntry(entry.fileName).catch(() => undefined),
          ),
      );
      return { entries: [...retained, ...downloaded], persistent };
    },
  );
}

export async function removePriwaOfflineMosaic(
  userId: string,
  projectId: string,
  mosaicId: string,
) {
  return navigator.locks.request(directoryName(userId, projectId), async () => {
    const directory = await openDirectory(userId, projectId);
    const entries = await readManifest(directory);
    await writeManifest(
      directory,
      entries.filter((entry) => entry.mosaic.id !== mosaicId),
    );
    await Promise.all(
      entries
        .filter((entry) => entry.mosaic.id === mosaicId)
        .map((entry) =>
          directory.removeEntry(entry.fileName).catch(() => undefined),
        ),
    );
  });
}
