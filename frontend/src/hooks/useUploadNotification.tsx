import { useRef } from "react";
import { notification, Progress } from "antd";

export type UploadNotifier = ReturnType<typeof createUploadNotifier>;

/** The progress toast of one upload, keyed by its upload ID. */
export const createUploadNotifier = (uploadKey: string, fileName: string) => {
  const showNotification = (
    type: "info" | "success" | "error" | "warning",
    status: string,
    percent?: number,
    onCancel?: () => void,
    reason?: string,
  ) => {
    const uploading = status === "uploading";
    const config = {
      key: uploadKey,
      message: uploading
        ? percent === 100
          ? "Processing data..."
          : type === "warning"
            ? "Upload paused"
            : "Uploading"
        : status === "success"
          ? "Upload Successful"
          : "Upload Failed",
      description: (
        <div>
          <div className="mt-2">{percent === 100 ? "Data is imported into the database" : fileName}</div>
          {reason && <div className="mt-2">{reason}</div>}
          {percent !== undefined && (
            <Progress percent={percent} size="small" status={status === "error" ? "exception" : undefined} />
          )}
        </div>
      ),
      // Keep a rejection reason open until the contributor dismisses it.
      duration: uploading || reason ? 0 : status === "success" ? 2 : 4,
      onClose: uploading ? onCancel : undefined,
    };

    notification[type](config);
  };

  return {
    showUploadingNotification: (onCancel?: () => void) => showNotification("info", "uploading", 0, onCancel),
    updateUploadProgress: (percent: number, onCancel?: () => void) =>
      showNotification("info", "uploading", percent, onCancel),
    // The connection dropped; the upload keeps retrying on its own.
    showStalledNotification: (percent: number, onCancel?: () => void) =>
      showNotification(
        "warning",
        "uploading",
        percent,
        onCancel,
        "Connection problem. Keep this tab open: the upload continues by itself when the connection is back.",
      ),
    showSuccessNotification: () => showNotification("success", "success"),
    showErrorNotification: (reason?: string) => showNotification("error", "error", undefined, undefined, reason),
    closeNotification: () => notification.destroy(uploadKey),
  };
};

export const useUploadNotification = (uploadKey: string, fileName: string) => {
  const notifier = useRef<UploadNotifier | null>(null);
  notifier.current = createUploadNotifier(uploadKey, fileName);
  return notifier.current;
};
