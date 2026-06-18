import { Button, Tooltip, Checkbox, Space, message } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { Settings } from "../../config";
import type { IDataset } from "../../types/dataset";
import { supabase } from "../../hooks/useSupabase";
import { useAuth } from "../../hooks/useAuthProvider";
import { resolveDownloadUrl } from "../../utils/downloadUrl";
import DesktopOnlyFeatureNotice from "../DesktopOnlyFeatureNotice";
import { useDesktopOnlyFeature } from "../../hooks/useDesktopOnlyFeature";
import { useAnalytics } from "../../hooks/useAnalytics";
import { canDownloadCompleteDataset } from "../../utils/datasetDownloads";

interface DownloadSectionProps {
  dataset: IDataset;
  labelsOnly: boolean;
  setLabelsOnly: (value: boolean) => void;
  hasExportableLabels: boolean;
  isDownloading: boolean;
  currentDownloadId: string | null;
  startDownload: (id: string) => boolean;
  finishDownload: () => void;
}

interface DownloadApiResponse {
  status?: string;
  job_id?: string;
  download_path?: string;
  message?: string;
  detail?: string;
}

export default function DownloadSection({
  dataset,
  labelsOnly,
  setLabelsOnly,
  hasExportableLabels,
  isDownloading,
  currentDownloadId,
  startDownload,
  finishDownload,
}: DownloadSectionProps) {
  const { session } = useAuth();
  const { isMobile } = useDesktopOnlyFeature();
  const { track } = useAnalytics("dataset_detail");
  const isViewOnlyDataset = dataset.data_access === "viewonly";
  const completeDatasetAvailable = canDownloadCompleteDataset(dataset);
  const forcedLabelsOnly =
    hasExportableLabels && (isViewOnlyDataset || !completeDatasetAvailable);
  const effectiveLabelsOnly = labelsOnly || forcedLabelsOnly;
  const shouldUseLabelsDownload =
    hasExportableLabels && effectiveLabelsOnly;
  const hasAvailableDownload = completeDatasetAvailable || shouldUseLabelsDownload;

  const getAuthHeaders = async (): Promise<Record<string, string>> => {
    const accessToken = session?.access_token;

    if (accessToken) {
      return { Authorization: `Bearer ${accessToken}` };
    }

    const { data } = await supabase.auth.getSession();
    const fallbackToken = data.session?.access_token;

    if (!fallbackToken) {
      throw new Error("Please log in to download datasets");
    }

    return { Authorization: `Bearer ${fallbackToken}` };
  };

  const parseJsonResponse = async (response: Response): Promise<DownloadApiResponse> => {
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      throw new Error("Invalid API response");
    }

    if (!response.ok) {
      const parsed = (data && typeof data === "object" ? data : {}) as DownloadApiResponse;
      const detail = parsed.detail || parsed.message || `Request failed (${response.status})`;
      throw new Error(detail);
    }

    return (data && typeof data === "object" ? data : {}) as DownloadApiResponse;
  };

  const handleDownload = () => {
    if (!session) {
      message.info("Please log in to download datasets.");
      return;
    }

    if (!hasAvailableDownload) {
      message.info("This dataset is not ready for download yet.");
      return;
    }

    if (isDownloading) {
      if (currentDownloadId !== dataset.id.toString()) {
        message.info("A download is already in progress. Please wait.");
      }
      return;
    }

    const downloadStarted = startDownload(dataset.id.toString());
    if (!downloadStarted) return;

    const downloadType = shouldUseLabelsDownload ? "labels" : "dataset";
    track("dataset_download_started", {
      dataset_id: dataset.id,
      download_type: downloadType,
    });

    const baseUrl = shouldUseLabelsDownload
      ? `${Settings.API_URL}/download/datasets/${dataset.id}/labels.gpkg`
      : `${Settings.API_URL}/download/datasets/${dataset.id}/dataset.zip`;

    const downloadMsg = message.loading({
      content: `Preparing ${shouldUseLabelsDownload ? "predictions" : "complete dataset"} for download...`,
      duration: 0,
    });

    getAuthHeaders()
      .then((headers) =>
        fetch(baseUrl, { headers })
          .then(parseJsonResponse)
          .then((data) => ({ data, headers })),
      )
      .then(({ data, headers }) => {
        const jobId = data.job_id;
        if (!jobId) {
          throw new Error("Missing job ID in download response");
        }
        const statusEndpoint = shouldUseLabelsDownload
          ? `${Settings.API_URL}/download/datasets/${dataset.id}/labels/status`
          : `${Settings.API_URL}/download/datasets/${jobId}/status`;
        const downloadEndpoint = shouldUseLabelsDownload
          ? `${Settings.API_URL}/download/datasets/${dataset.id}/labels/download`
          : `${Settings.API_URL}/download/datasets/${jobId}/download`;

        const checkStatus = () => {
          fetch(statusEndpoint, { headers })
            .then(parseJsonResponse)
            .then((statusData) => {
              if (statusData.status === "completed") {
                const downloadUrl = resolveDownloadUrl(statusData.download_path, downloadEndpoint);
                if (!downloadUrl) {
                  throw new Error("Missing download URL in status response");
                }

                downloadMsg();
                finishDownload();
                track("dataset_download_completed", {
                  dataset_id: dataset.id,
                  download_type: downloadType,
                });
                window.location.href = downloadUrl;
                message.success({
                  content: `${shouldUseLabelsDownload ? "Predictions" : "Dataset"} download started!`,
                  duration: 5,
                });
              } else if (statusData.status === "failed") {
                downloadMsg();
                finishDownload();
                track("dataset_download_failed", {
                  dataset_id: dataset.id,
                  download_type: downloadType,
                  failure_reason: statusData.message || "preparation_failed",
                });
                message.error({
                  content: statusData.message || "Download preparation failed. Please try again.",
                  duration: 5,
                });
              } else {
                setTimeout(checkStatus, 1000);
              }
            })
            .catch((error) => {
              downloadMsg();
              finishDownload();
              track("dataset_download_failed", {
                dataset_id: dataset.id,
                download_type: downloadType,
                failure_reason: error.message,
              });
              message.error({ content: `Error checking download status: ${error.message}`, duration: 5 });
            });
        };

        checkStatus();
      })
      .catch((error) => {
        downloadMsg();
        finishDownload();
        track("dataset_download_failed", {
          dataset_id: dataset.id,
          download_type: downloadType,
          failure_reason: error.message,
        });
        message.error({ content: `Error initiating download: ${error.message}`, duration: 5 });
      });
  };

  const tooltipTitle = isDownloading
    ? currentDownloadId === dataset.id.toString()
      ? "This dataset is currently being prepared for download..."
      : "Another download is in progress. Only one download can be active at a time."
    : !session
      ? "Please log in to download datasets."
    : !hasAvailableDownload
      ? "Downloads are available after dataset processing finishes."
    : forcedLabelsOnly && !labelsOnly
      ? "Only labels/predictions are available for this dataset."
      : shouldUseLabelsDownload
        ? "Download vector data of tree mortality predictions (GPKG format)"
        : "Download both orthophoto and tree mortality predictions";

  if (isMobile) {
    return (
      <DesktopOnlyFeatureNotice
        title="Desktop Only"
        description="Open on desktop to download files."
      />
    );
  }

  return (
    <div className="shrink-0" data-testid="dataset-download-section">
      <div className="rounded-2xl border border-slate-300/80 bg-white/98 p-4 shadow-md">
        <Space direction="vertical" className="w-full">
          {isDownloading && currentDownloadId !== dataset.id.toString() && (
            <div className="mb-2 text-center text-sm text-orange-500">Another download is in progress</div>
          )}
          {isViewOnlyDataset && (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-center text-xs text-amber-700">
              View-only dataset: orthophoto download is restricted. Predictions (GPKG) are available.
            </div>
          )}
          <Tooltip title={tooltipTitle}>
            <Button
              type="primary"
              size="large"
              icon={<DownloadOutlined />}
              className="w-full shadow-sm"
              disabled={!session || isDownloading || !hasAvailableDownload}
              loading={isDownloading && currentDownloadId === dataset.id.toString()}
              onClick={handleDownload}
            >
              {!hasAvailableDownload
                ? "Download unavailable"
                : shouldUseLabelsDownload
                  ? "Download Predictions (GPKG)"
                  : "Download Complete Dataset"}
            </Button>
          </Tooltip>
          {hasExportableLabels && (
            <Tooltip title="Only download the vector data containing tree mortality predictions, without the orthophoto">
              <Checkbox
                checked={effectiveLabelsOnly}
                disabled={isViewOnlyDataset || !completeDatasetAvailable}
                onChange={(e) => setLabelsOnly(e.target.checked)}
                className="mt-2 flex justify-center text-gray-600"
              >
                Download predictions only
              </Checkbox>
            </Tooltip>
          )}
        </Space>
      </div>
    </div>
  );
}
