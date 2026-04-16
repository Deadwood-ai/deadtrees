import axios from "axios";
import { Settings } from "../config";
import { clearLocalSupabaseSession, supabase } from "../hooks/useSupabase";
import { isInvalidSessionError } from "../utils/authSession";
import { isTokenExpiringSoon } from "../utils/isTokenExpiringSoon";

interface UploadOptions {
  file: File;
  metadata: {
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
  };
  onProgress: (progress: { percent: number }) => void;
  onSuccess: (response: any) => void;
  onError: (error: Error) => void;
  uploadId: string;
  session: any;
  signal?: AbortSignal;
}

interface ChunkInfo {
  index: number;
  start: number;
  end: number;
  data: Blob;
}

const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB
const CHUNK_UPLOAD_TIMEOUT_MS = 1000 * 60 * 60; // 60 minutes per chunk
const MAX_CHUNK_UPLOAD_ATTEMPTS = 3;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

// const refreshToken = async () => {
//   const { data, error } = await supabase.auth.refreshSession();
//   if (error) {
//     console.error("Error refreshing token:", error);
//     throw error;
//   }
//   return data.session?.access_token;
// };

const uploadOrtho = async (options: UploadOptions) => {
  const { file, onSuccess, onError, signal } = options;
  const uploadStartTime = Date.now();

  try {
    if (signal?.aborted) {
      throw new DOMException("Upload cancelled by user", "AbortError");
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const resUpload = await uploadChunks(file, totalChunks, uploadStartTime, options);
    onSuccess(resUpload);
  } catch (error) {
    handleError(error, onError);
  }
};

async function uploadChunks(file: File, totalChunks: number, uploadStartTime: number, options: UploadOptions) {
  let resUpload;
  let currentSession = options.session;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    // Check if token needs refresh before each chunk upload
    if (isTokenExpiringSoon(currentSession)) {
      const { data, error } = await supabase.auth.refreshSession();
      if (error) {
        if (isInvalidSessionError(error)) {
          await clearLocalSupabaseSession();
          throw new Error("Session expired. Please sign in again.");
        }

        console.error("Error refreshing token:", error);
        throw error;
      }
      currentSession = data.session;
      // console.log("Token refreshed");
      // console.log("currentSession", currentSession);
    }

    const chunkInfo = getChunkInfo(file, chunkIndex);
    const formData = createFormData(
      chunkInfo,
      totalChunks,
      file.name,
      options.uploadId,
      uploadStartTime,
      options.metadata,
    );

    resUpload = await uploadSingleChunk(formData, chunkInfo, file.size, {
      ...options,
      session: currentSession,
    });
  }

  return resUpload?.data;
}

function getChunkInfo(file: File, chunkIndex: number): ChunkInfo {
  const start = chunkIndex * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, file.size);
  return {
    index: chunkIndex,
    start,
    end,
    data: file.slice(start, end),
  };
}

function createFormData(
  chunkInfo: ChunkInfo,
  totalChunks: number,
  fileName: string,
  uploadId: string,
  startTime: number,
  metadata: {
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
  },
): FormData {
  const formData = new FormData();
  formData.append("file", chunkInfo.data, fileName);
  formData.append("chunk_index", chunkInfo.index.toString());
  formData.append("chunks_total", totalChunks.toString());
  formData.append("upload_id", uploadId);
  formData.append("copy_time", calculateCopyTime(startTime).toString());

  // Add metadata fields
  formData.append("license", "CC BY");
  formData.append("platform", metadata.platform);

  // Handle authors array
  metadata.authors.forEach((author) => {
    formData.append("authors", author);
  });

  // Optional fields
  if (metadata.upload_type) formData.append("upload_type", metadata.upload_type);
  if (metadata.project_id) formData.append("project_id", metadata.project_id);
  if (metadata.aquisition_year) formData.append("aquisition_year", metadata.aquisition_year.toString());
  if (metadata.aquisition_month) formData.append("aquisition_month", metadata.aquisition_month.toString());
  if (metadata.aquisition_day) formData.append("aquisition_day", metadata.aquisition_day.toString());
  if (metadata.additional_information) formData.append("additional_information", metadata.additional_information);
  if (metadata.data_access) formData.append("data_access", metadata.data_access);
  if (metadata.citation_doi) formData.append("citation_doi", metadata.citation_doi);

  return formData;
}

function calculateCopyTime(startTime: number): number {
  return Math.round((Date.now() - startTime) / 1000);
}

async function uploadSingleChunk(formData: FormData, chunkInfo: ChunkInfo, fileSize: number, options: UploadOptions) {
  const { session, onProgress, signal } = options;
  const accessToken = session?.access_token;

  if (!accessToken) {
    throw new Error("Missing auth session for upload");
  }

  // console.log("FormData contents:");
  // for (const pair of formData.entries()) {
  //   console.log(pair[0], pair[1]);
  // }

  for (let attempt = 1; attempt <= MAX_CHUNK_UPLOAD_ATTEMPTS; attempt++) {
    try {
      const resUpload = await axios.post(`${Settings.API_URL_UPLOAD_ENDPOINT}`, formData, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const percentComplete = calculateProgress(chunkInfo, progressEvent, fileSize);
            onProgress({ percent: percentComplete });
          }
        },
        timeout: CHUNK_UPLOAD_TIMEOUT_MS,
        signal: signal,
      });
      return resUpload;
    } catch (error) {
      if (axios.isCancel(error)) {
        throw new DOMException("Upload cancelled by user", "AbortError");
      }

      if (attempt < MAX_CHUNK_UPLOAD_ATTEMPTS && shouldRetryChunkUpload(error)) {
        await waitForRetryDelay(attempt, signal);
        continue;
      }

      throw createChunkUploadError(error, chunkInfo.index);
    }
  }

  throw new Error(`Failed to upload chunk ${chunkInfo.index}: exhausted retry attempts`);
}

function calculateProgress(chunkInfo: ChunkInfo, progressEvent: any, fileSize: number): number {
  const chunkProgress = progressEvent.loaded / progressEvent.total;
  const overallProgress = (chunkInfo.index * CHUNK_SIZE + chunkProgress * (chunkInfo.end - chunkInfo.start)) / fileSize;
  return Math.round(overallProgress * 100);
}

function shouldRetryChunkUpload(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  if (error.code === "ECONNABORTED") {
    return true;
  }

  if (!error.response) {
    return true;
  }

  return RETRYABLE_STATUS_CODES.has(error.response.status);
}

function createChunkUploadError(error: unknown, chunkIndex: number): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const detail =
      (typeof error.response?.data === "object" &&
        error.response?.data &&
        "detail" in error.response.data &&
        (error.response.data as { detail?: unknown }).detail) ||
      (typeof error.response?.data === "string" ? error.response.data : undefined) ||
      error.message;

    return new Error(`Failed to upload chunk ${chunkIndex} (status ${status ?? "unknown"}): ${String(detail)}`);
  }

  return new Error(`Failed to upload chunk ${chunkIndex}: ${error instanceof Error ? error.message : "unknown error"}`);
}

async function waitForRetryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  const retryDelayMs = Math.min(1000 * 2 ** attempt, 10000);

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload cancelled by user", "AbortError"));
      return;
    }

    const timeoutId = window.setTimeout(() => {
      cleanup();
      resolve();
    }, retryDelayMs);

    const onAbort = () => {
      window.clearTimeout(timeoutId);
      cleanup();
      reject(new DOMException("Upload cancelled by user", "AbortError"));
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function handleError(error: unknown, onError: (error: Error) => void) {
  onError(error instanceof Error ? error : new Error("Upload failed"));
}

export default uploadOrtho;
