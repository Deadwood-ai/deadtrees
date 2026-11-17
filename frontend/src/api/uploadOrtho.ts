// Sends an orthophoto or raw-image ZIP to the chunk API and resumes it after any
// interruption. The server keeps a receipt per chunk (docs/playbooks/upload-retry-contract.md);
// this loop asks it which chunks it already holds and sends only the rest, for a
// fresh upload and a resumed one alike.
import axios, { type AxiosResponse } from "axios";
import { Settings } from "../config";
import { sha256Hex } from "../utils/uploadFingerprint";

export const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MiB
// A chunk request that sends no bytes for this long is dropped and retried.
const NO_PROGRESS_TIMEOUT_MS = 2 * 60 * 1000;
// After its bytes are sent, the server may still validate and finalize the upload.
const RESPONSE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 30 * 1000;
// Failures in a row before the upload counts as stalled (reported once).
const STALL_AFTER_FAILURES = 3;
// A chunk that keeps failing for this long ends the run; the upload stays resumable.
const GIVE_UP_AFTER_MS = 30 * 60 * 1000;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/** The form fields every chunk repeats; the server binds them to the upload ID. */
export interface UploadMetadata {
  license: string;
  platform: string;
  authors: string[];
  upload_type?: string;
  project_id?: string;
  aquisition_year?: number;
  aquisition_month?: number;
  aquisition_day?: number;
  additional_information?: string;
  data_access?: string;
  citation_doi?: string;
}

export type UploadOrthoResponse = {
  id: string;
} & Record<string, unknown>;

export interface ChunkReceipt {
  size: number;
  sha256: string;
}

/** The server's view of one upload (GET /datasets/uploads/{id}). */
export interface UploadStatus {
  upload_id: string;
  state: "receiving" | "expired" | "finalizing" | "complete";
  chunks_total: number | null;
  chunks_received: number;
  bytes_received: number;
  last_chunk: ChunkReceipt | null;
  contract: Record<string, unknown> | null;
  response: UploadOrthoResponse | null;
  created_at: number | null;
  updated_at: number;
}

export type TransferEvent =
  | { type: "chunk_failed"; chunkIndex: number; chunksTotal: number; attempt: number; reason: string }
  | { type: "stalled"; chunkIndex: number; chunksTotal: number; reason: string }
  | { type: "recovered"; chunkIndex: number; chunksTotal: number }
  | { type: "resumed"; chunkIndex: number; chunksTotal: number };

export interface TransferOptions {
  file: File;
  uploadId: string;
  metadata: UploadMetadata;
  /** A valid access token; `refresh` forces a new one after the API rejected the last. */
  getAccessToken: (refresh?: boolean) => Promise<string>;
  onProgress: (percent: number) => void;
  onEvent?: (event: TransferEvent) => void;
  signal?: AbortSignal;
  chunkSize?: number;
  /** A brand-new upload ID: nothing to ask the server before the first chunk. */
  isNew?: boolean;
}

/** The API refused the file itself (HTTP 400, or 409 for a duplicate); the message is its reason for the contributor. */
export class UploadRejectedError extends Error {
  name = "UploadRejectedError";
}

/** The upload cannot continue under this ID; the contributor has to start a new upload. */
export class UploadNotResumableError extends Error {
  name = "UploadNotResumableError";
}

/** The picked file is not the one the unfinished upload started with; nothing was sent. */
export class UploadFileMismatchError extends Error {
  name = "UploadFileMismatchError";
}

const abortError = () => new DOMException("Upload cancelled by user", "AbortError");

export const chunkCount = (fileSize: number, chunkSize = CHUNK_SIZE) => Math.max(1, Math.ceil(fileSize / chunkSize));

export async function fetchUploadStatus(uploadId: string, token: string): Promise<UploadStatus | null> {
  try {
    const response = await axios.get<UploadStatus>(
      `${Settings.API_URL}/datasets/uploads/${encodeURIComponent(uploadId)}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30_000 },
    );
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) return null;
    throw error;
  }
}

export async function listUnfinishedUploads(token: string): Promise<UploadStatus[]> {
  const response = await axios.get<UploadStatus[]>(`${Settings.API_URL}/datasets/uploads`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30_000,
  });
  return response.data;
}

/** Where to continue, after checking that the server's bytes came from this file. */
async function firstChunkToSend(status: UploadStatus | null, file: File, chunkSize: number, chunksTotal: number) {
  if (!status || status.chunks_received === 0) return 0;
  if (status.state === "expired") {
    throw new UploadNotResumableError(
      "This upload was paused for too long and its data was removed. Please start the upload again.",
    );
  }
  if (status.state === "finalizing") {
    throw new UploadNotResumableError(
      "This upload stopped while it was being finished. Please contact info@deadtrees.earth before uploading it again.",
    );
  }
  const received = status.chunks_received;
  const last = status.last_chunk;
  const start = (received - 1) * chunkSize;
  const matches =
    status.chunks_total === chunksTotal &&
    last !== null &&
    last.size === Math.min(chunkSize, file.size - start) &&
    (await sha256Hex(file.slice(start, start + last.size))) === last.sha256;
  if (!matches) {
    throw new UploadFileMismatchError("This file does not match the unfinished upload. Pick the same file you started with.");
  }
  // Every chunk arrived but the reply to the last was lost or rejected: send it again to finish.
  return Math.min(received, chunksTotal - 1);
}

function chunkForm(file: File, uploadId: string, index: number, chunksTotal: number, chunkSize: number, metadata: UploadMetadata) {
  const formData = new FormData();
  formData.append("file", file.slice(index * chunkSize, Math.min((index + 1) * chunkSize, file.size)), file.name);
  formData.append("chunk_index", index.toString());
  formData.append("chunks_total", chunksTotal.toString());
  formData.append("upload_id", uploadId);
  formData.append("license", metadata.license);
  formData.append("platform", metadata.platform);
  metadata.authors.forEach((author) => formData.append("authors", author));
  const optional: (keyof UploadMetadata)[] = [
    "upload_type",
    "project_id",
    "aquisition_year",
    "aquisition_month",
    "aquisition_day",
    "additional_information",
    "data_access",
    "citation_doi",
  ];
  for (const key of optional) {
    const value = metadata[key];
    if (value !== undefined && value !== null && value !== "") formData.append(key, String(value));
  }
  return formData;
}

type ChunkFailure = { kind: "abort" } | { kind: "retry"; reason: string; refreshToken?: boolean } | { kind: "fatal"; error: Error };

function classify(error: unknown, chunkIndex: number, userSignal?: AbortSignal, noProgress?: boolean): ChunkFailure {
  if (userSignal?.aborted) return { kind: "abort" };
  if (noProgress) return { kind: "retry", reason: "no_progress" };
  if (!axios.isAxiosError(error)) {
    return { kind: "fatal", error: error instanceof Error ? error : new Error("Upload failed") };
  }
  const status = error.response?.status;
  const data = error.response?.data as { detail?: unknown } | string | undefined;
  const detail = (typeof data === "object" && data?.detail) || (typeof data === "string" ? data : undefined) || error.message;
  if (status === undefined || error.code === "ECONNABORTED") {
    return { kind: "retry", reason: error.code === "ECONNABORTED" ? "timeout" : "network_error" };
  }
  if (status === 401) return { kind: "retry", reason: "invalid_token", refreshToken: true };
  if (RETRYABLE_STATUS_CODES.has(status)) return { kind: "retry", reason: `http_${status}` };
  if (status === 400) return { kind: "fatal", error: new UploadRejectedError(String(detail)) };
  if (status === 409 && typeof detail === "object" && (detail as { code?: unknown }).code === "DUPLICATE_UPLOAD") {
    return { kind: "fatal", error: new UploadRejectedError(String((detail as { message?: unknown }).message)) };
  }
  if (status === 409 && typeof detail === "string" && /data is missing|finalization was interrupted/.test(detail)) {
    return { kind: "fatal", error: new UploadNotResumableError(detail) };
  }
  return {
    kind: "fatal",
    error: new Error(`Failed to upload chunk ${chunkIndex} (status ${status}): ${typeof detail === "string" ? detail : JSON.stringify(detail)}`),
  };
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      done();
      reject(abortError());
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitUntilOnline(signal?: AbortSignal) {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("online", onOnline);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOnline = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    window.addEventListener("online", onOnline);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One request; dropped when it sends no bytes for NO_PROGRESS_TIMEOUT_MS. */
async function postChunk(
  formData: FormData,
  token: string,
  onBytes: (loaded: number) => void,
  userSignal?: AbortSignal,
): Promise<{ response?: AxiosResponse<UploadOrthoResponse>; error?: unknown; noProgress: boolean }> {
  const request = new AbortController();
  let noProgress = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      noProgress = true;
      request.abort();
    }, ms);
  };
  const forwardAbort = () => request.abort();
  userSignal?.addEventListener("abort", forwardAbort, { once: true });
  arm(NO_PROGRESS_TIMEOUT_MS);
  try {
    const response = await axios.post<UploadOrthoResponse>(Settings.API_URL_UPLOAD_ENDPOINT, formData, {
      headers: { Authorization: `Bearer ${token}` },
      signal: request.signal,
      onUploadProgress: (event) => {
        onBytes(event.loaded);
        // Once every byte is out, only the server's answer is left to wait for.
        arm(event.total && event.loaded >= event.total ? RESPONSE_TIMEOUT_MS : NO_PROGRESS_TIMEOUT_MS);
      },
    });
    return { response, noProgress };
  } catch (error) {
    return { error, noProgress };
  } finally {
    clearTimeout(watchdog);
    userSignal?.removeEventListener("abort", forwardAbort);
  }
}

/** Upload `file` under `uploadId`, continuing from whatever the server already holds. */
export async function transferUpload(options: TransferOptions): Promise<UploadOrthoResponse> {
  const { file, uploadId, metadata, getAccessToken, onProgress, onEvent, signal } = options;
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;
  const chunksTotal = chunkCount(file.size, chunkSize);
  if (signal?.aborted) throw abortError();

  let token = await getAccessToken();
  const status = options.isNew ? null : await fetchUploadStatus(uploadId, token);
  if (status?.state === "complete" && status.response) return status.response;
  const first = await firstChunkToSend(status, file, chunkSize, chunksTotal);
  if (first > 0) onEvent?.({ type: "resumed", chunkIndex: first, chunksTotal });

  let response: AxiosResponse<UploadOrthoResponse> | undefined;
  for (let index = first; index < chunksTotal; index++) {
    const formData = chunkForm(file, uploadId, index, chunksTotal, chunkSize, metadata);
    const report = (loaded: number) => onProgress(Math.min(100, Math.round(((index * chunkSize + loaded) / file.size) * 100)));
    report(0);
    let failingSince = 0;
    for (let failures = 0; ; ) {
      await waitUntilOnline(signal);
      const result = await postChunk(formData, token, report, signal);
      if (result.response) {
        response = result.response;
        if (failures >= STALL_AFTER_FAILURES) onEvent?.({ type: "recovered", chunkIndex: index, chunksTotal });
        break;
      }
      const failure = classify(result.error, index, signal, result.noProgress);
      if (failure.kind === "abort") throw abortError();
      if (failure.kind === "fatal") throw failure.error;
      failures++;
      failingSince ||= Date.now();
      onEvent?.({ type: "chunk_failed", chunkIndex: index, chunksTotal, attempt: failures, reason: failure.reason });
      if (failures === STALL_AFTER_FAILURES) onEvent?.({ type: "stalled", chunkIndex: index, chunksTotal, reason: failure.reason });
      if (Date.now() - failingSince > GIVE_UP_AFTER_MS) {
        throw new Error(`Upload stopped at chunk ${index + 1} of ${chunksTotal} (${failure.reason}). You can continue it later.`);
      }
      await wait(Math.min(1000 * 2 ** Math.min(failures, 5), MAX_RETRY_DELAY_MS), signal);
      if (failure.refreshToken) token = await getAccessToken(true);
    }
  }
  if (!response?.data?.id) throw new Error("Upload did not return a dataset response");
  return response.data;
}
