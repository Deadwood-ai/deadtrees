// Uploads this browser started and has not seen through to processing. The server
// keeps the bytes (GET /datasets/uploads); this record adds what only the browser
// knows: which file it was and which processing steps to start afterwards.
import type { UploadMetadata } from "../api/uploadOrtho";

export interface PendingUpload {
  uploadId: string;
  userId: string;
  fileName: string;
  fileSize: number;
  chunkSize: number;
  metadata: UploadMetadata;
  processingSteps: string[];
}

const STORAGE_KEY = "deadtrees.pendingUploads.v1";
const DISCARDED_KEY = "deadtrees.discardedUploads.v1";

const storage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const read = <T>(key: string, fallback: T): T => {
  try {
    const parsed = JSON.parse(storage()?.getItem(key) ?? "null");
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const write = (key: string, value: unknown) => {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the server's list still offers the upload for recovery.
  }
};

const readAll = () => read<Record<string, PendingUpload>>(STORAGE_KEY, {});
const writeAll = (uploads: Record<string, PendingUpload>) => write(STORAGE_KEY, uploads);

export const savePendingUpload = (upload: PendingUpload) => writeAll({ ...readAll(), [upload.uploadId]: upload });

export const removePendingUpload = (uploadId: string) => {
  const uploads = readAll();
  delete uploads[uploadId];
  writeAll(uploads);
};

export const pendingUploadsFor = (userId: string): PendingUpload[] =>
  Object.values(readAll()).filter((upload) => upload.userId === userId);

/** Uploads the contributor discarded; the server deletes their bytes when they expire. */
export const discardedUploadIds = (): Set<string> => new Set(read<string[]>(DISCARDED_KEY, []));

export const discardUpload = (uploadId: string) => {
  write(DISCARDED_KEY, [...discardedUploadIds(), uploadId].slice(-200));
  removePendingUpload(uploadId);
};

/** A picked file is the upload's file when name and size match; the server then checks the bytes. */
export const isSameFile = (upload: Pick<PendingUpload, "fileName" | "fileSize">, file: File) =>
  file.name === upload.fileName && file.size === upload.fileSize;

// A running upload holds a Web Lock named after its ID, so every tab of this
// browser sees it and the recovery panel never offers it while it runs.
export const UPLOADS_CHANGED_EVENT = "deadtrees:uploads-changed";
const LOCK_PREFIX = "deadtrees-upload:";

const notifyUploadsChanged = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(UPLOADS_CHANGED_EVENT));
};

/**
 * Run `work` while holding the upload's lock. Returns false without running it
 * when another tab already runs this upload. Browsers without Web Locks run it unguarded.
 */
export const withUploadLock = async (uploadId: string, work: () => Promise<void>): Promise<boolean> => {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  const run = async () => {
    notifyUploadsChanged();
    try {
      await work();
    } finally {
      notifyUploadsChanged();
    }
  };
  if (!locks) {
    await run();
    return true;
  }
  return locks.request(`${LOCK_PREFIX}${uploadId}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await run();
    return true;
  });
};

export const uploadsRunningInAnyTab = async (): Promise<Set<string>> => {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return new Set();
  const { held = [] } = await locks.query();
  return new Set(
    held.flatMap((lock) => (lock.name?.startsWith(LOCK_PREFIX) ? [lock.name.slice(LOCK_PREFIX.length)] : [])),
  );
};
