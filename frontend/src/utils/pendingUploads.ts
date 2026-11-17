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

// Uploads running in this tab right now; the recovery panel leaves them out.
const activeUploadIds = new Set<string>();
export const UPLOADS_CHANGED_EVENT = "deadtrees:uploads-changed";

const notifyUploadsChanged = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(UPLOADS_CHANGED_EVENT));
};

export const setUploadActive = (uploadId: string, active: boolean) => {
  if (active) activeUploadIds.add(uploadId);
  else activeUploadIds.delete(uploadId);
  notifyUploadsChanged();
};

export const isUploadActive = (uploadId: string) => activeUploadIds.has(uploadId);
