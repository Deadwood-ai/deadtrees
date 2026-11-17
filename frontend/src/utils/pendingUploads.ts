// Uploads this browser started and has not seen through to processing. The server
// keeps the bytes (GET /datasets/uploads); this record adds what only the browser
// knows: which file it was and which processing steps to start afterwards.
import type { UploadMetadata } from "../api/uploadOrtho";

export interface PendingUpload {
  uploadId: string;
  userId: string;
  fileName: string;
  fileSize: number;
  fileLastModified: number;
  chunkSize: number;
  metadata: UploadMetadata;
  processingSteps: string[];
  startedAt: number;
}

const STORAGE_KEY = "deadtrees.pendingUploads.v1";

const storage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const readAll = (): Record<string, PendingUpload> => {
  try {
    const parsed = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeAll = (uploads: Record<string, PendingUpload>) => {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(uploads));
  } catch {
    // Storage full or blocked: the server's list still offers the upload for recovery.
  }
};

export const savePendingUpload = (upload: PendingUpload) => writeAll({ ...readAll(), [upload.uploadId]: upload });

export const removePendingUpload = (uploadId: string) => {
  const uploads = readAll();
  delete uploads[uploadId];
  writeAll(uploads);
};

export const pendingUploadsFor = (userId: string): PendingUpload[] =>
  Object.values(readAll()).filter((upload) => upload.userId === userId);

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
