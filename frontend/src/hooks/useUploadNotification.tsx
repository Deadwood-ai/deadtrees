import { useRef } from "react";
import { notification, Progress } from "antd";

export const useUploadNotification = (uploadKey: string, fileName: string) => {
  const uploadKeyRef = useRef(uploadKey);

  const showNotification = (
    type: "info" | "success" | "error",
    status: string,
    percent?: number,
    onCancel?: () => void,
    reason?: string,
  ) => {
    const config = {
      key: uploadKeyRef.current,
      message:
        status === "uploading"
          ? percent === 100
            ? "Processing data..."
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
      duration: status === "uploading" || reason ? 0 : status === "success" ? 2 : 4,
      onClose: status === "uploading" ? onCancel : undefined,
    };

    notification[type](config);
  };

  const closeNotification = () => {
    notification.destroy(uploadKeyRef.current);
  };

  return {
    showUploadingNotification: (onCancel?: () => void) => showNotification("info", "uploading", 0, onCancel),
    updateUploadProgress: (percent: number, onCancel?: () => void) =>
      showNotification("info", "uploading", percent, onCancel),
    showSuccessNotification: () => showNotification("success", "success"),
    showErrorNotification: (reason?: string) => showNotification("error", "error", undefined, undefined, reason),
    closeNotification,
  };
};
