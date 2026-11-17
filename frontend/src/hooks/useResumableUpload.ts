// Runs one upload end to end, fresh or resumed: keep-alive, the browser's record of
// the upload, the transfer, the processing request, analytics and the progress toast.
import { useCallback } from "react";
import { supabase, clearLocalSupabaseSession } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { useAnalytics } from "./useAnalytics";
import { createUploadNotifier } from "./useUploadNotification";
import addProcess from "../api/addProcess";
import {
  CHUNK_SIZE,
  chunkCount,
  transferUpload,
  UploadFileMismatchError,
  UploadNotResumableError,
  UploadRejectedError,
  type TransferEvent,
  type UploadMetadata,
} from "../api/uploadOrtho";
import { isInvalidSessionError } from "../utils/authSession";
import { holdUploadKeepAlive } from "../utils/uploadKeepAlive";
import { removePendingUpload, savePendingUpload, withUploadLock } from "../utils/pendingUploads";
import { message as toast } from "antd";
import type { SourceSurface } from "../utils/analytics";

export interface RunUploadOptions {
  file: File;
  uploadId: string;
  metadata: UploadMetadata;
  processingSteps: string[];
  uploadType: string;
  chunkSize?: number;
  /** Set when the contributor continues an upload from the recovery panel. */
  resumed?: boolean;
}

/** The signed-in user's token for upload calls; `refresh` forces a new one after the API rejected it. */
export const getAccessToken = async (refresh = false): Promise<string> => {
  const { data, error } = refresh ? await supabase.auth.refreshSession() : await supabase.auth.getSession();
  if (error) {
    if (isInvalidSessionError(error)) {
      await clearLocalSupabaseSession();
      throw new Error("Session expired. Please sign in again, then continue the upload from your profile.");
    }
    throw error;
  }
  if (!data.session?.access_token) throw new Error("Session expired. Please sign in again.");
  return data.session.access_token;
};

export function useResumableUpload(sourceSurface: SourceSurface) {
  const { user } = useAuth();
  const { track } = useAnalytics(sourceSurface);

  const runOnce = useCallback(
    async (options: RunUploadOptions): Promise<void> => {
      const { file, uploadId, metadata, processingSteps, uploadType } = options;
      const chunkSize = options.chunkSize ?? CHUNK_SIZE;
      const transfer = {
        upload_type: uploadType,
        chunks_total: chunkCount(file.size, chunkSize),
        file_size_mb: Math.round(file.size / (1024 * 1024)),
      };
      const notifier = createUploadNotifier(uploadId, file.name);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const release = holdUploadKeepAlive();
      let percent = 0;
      let stalled = false;
      let lastChunk = 0;

      if (user) {
        savePendingUpload({
          uploadId,
          userId: user.id,
          fileName: file.name,
          fileSize: file.size,
          chunkSize,
          metadata,
          processingSteps,
        });
      }
      if (!options.resumed) track("upload_started", { upload_type: uploadType });
      notifier.showUploadingNotification(cancel);

      const onEvent = (event: TransferEvent) => {
        lastChunk = event.chunkIndex;
        const properties = { ...transfer, chunk_index: event.chunkIndex };
        if (event.type === "chunk_failed") {
          track("upload_chunk_failed", { ...properties, attempt: event.attempt, failure_reason: event.reason });
        } else if (event.type === "stalled") {
          stalled = true;
          track("upload_stalled", { ...properties, failure_reason: event.reason });
          notifier.showStalledNotification(percent, cancel);
        } else if (event.type === "recovered") {
          stalled = false;
          track("upload_resumed", { ...properties, resume_source: "retry" });
          notifier.updateUploadProgress(percent, cancel);
        } else {
          track("upload_resumed", { ...properties, resume_source: "recovery" });
        }
      };

      try {
        const response = await transferUpload({
          file,
          uploadId,
          metadata,
          chunkSize,
          isNew: !options.resumed,
          getAccessToken,
          signal: controller.signal,
          onEvent,
          onProgress: (next) => {
            percent = next;
            if (stalled) notifier.showStalledNotification(next, cancel);
            else notifier.updateUploadProgress(next, cancel);
          },
        });
        const datasetId = Number(response.id);
        await addProcess(datasetId, processingSteps, await getAccessToken());
        removePendingUpload(uploadId);
        track("upload_completed", { dataset_id: datasetId, upload_type: uploadType });
        notifier.showSuccessNotification();
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          // The bytes stay on the server; the profile page offers to continue or discard.
          track("upload_cancelled", { ...transfer, chunk_index: lastChunk });
          notifier.closeNotification();
          return;
        }
        if (error instanceof UploadFileMismatchError) {
          notifier.showErrorNotification(error.message);
          return;
        }
        console.error("Upload error:", error);
        const message = error instanceof Error ? error.message : "unknown_error";
        track("upload_failed", { upload_type: uploadType, failure_reason: message });
        if (error instanceof UploadRejectedError || error instanceof UploadNotResumableError) {
          // This upload cannot continue: forget it, and say why.
          removePendingUpload(uploadId);
          notifier.showErrorNotification(message);
        } else {
          notifier.showErrorNotification(
            `${message} Your upload is saved: open your profile and choose "Continue upload" to carry on where it stopped.`,
          );
        }
        return;
      } finally {
        release();
      }
    },
    [track, user],
  );

  return useCallback(
    async (options: RunUploadOptions): Promise<void> => {
      if (!(await withUploadLock(options.uploadId, () => runOnce(options)))) {
        toast.info("This upload is already running in another tab.");
      }
    },
    [runOnce],
  );
}
