// Uploads that stopped before the end, with a way to continue each one. The
// server lists what it holds; this browser adds the uploads it remembers. A
// contributor has to pick the file again, because browsers forget file access
// when a tab closes. The panel has no close button on purpose: an upload leaves
// it only by finishing or by an explicit, confirmed discard.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Popconfirm, Space, message } from "antd";
import { useAuth } from "../../hooks/useAuthProvider";
import { useAnalytics } from "../../hooks/useAnalytics";
import { useResumableUpload } from "../../hooks/useResumableUpload";
import { supabase } from "../../hooks/useSupabase";
import addProcess from "../../api/addProcess";
import {
  CHUNK_SIZE,
  chunkCount,
  fetchUploadStatus,
  listUnfinishedUploads,
  type UploadMetadata,
  type UploadStatus,
} from "../../api/uploadOrtho";
import {
  isUploadActive,
  pendingUploadsFor,
  removePendingUpload,
  UPLOADS_CHANGED_EVENT,
  type PendingUpload,
} from "../../utils/pendingUploads";
import { processingStepsFor } from "../../utils/uploadProcessingSteps";

interface UnfinishedUpload {
  uploadId: string;
  fileName: string;
  /** Only known when this browser started the upload. */
  local?: PendingUpload;
  /** null: the server has no bytes yet (the upload stopped before its first chunk). */
  status: UploadStatus | null;
}

const DISMISSED_KEY = "deadtrees.discardedUploads.v1";

const readDismissed = (): string[] => {
  try {
    return JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "[]");
  } catch {
    return [];
  }
};

const dismiss = (uploadId: string) => {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...readDismissed(), uploadId].slice(-200)));
  } catch {
    // Without storage the upload shows again on reload until its data expires.
  }
};

const formatSize = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;

const contractMetadata = (contract: Record<string, unknown>): UploadMetadata => {
  const optional = (key: string) => (contract[key] ?? undefined) as never;
  return {
    license: String(contract.license),
    platform: String(contract.platform),
    authors: (contract.authors as string[]) ?? [],
    upload_type: optional("upload_type"),
    project_id: optional("project_id"),
    aquisition_year: optional("aquisition_year"),
    aquisition_month: optional("aquisition_month"),
    aquisition_day: optional("aquisition_day"),
    additional_information: optional("additional_information"),
    data_access: optional("data_access"),
    citation_doi: optional("citation_doi"),
  };
};

/** The chunk size the upload was started with; all chunks but the last share it. */
const chunkSizeOf = (upload: UnfinishedUpload) => {
  const status = upload.status;
  if (upload.local) return upload.local.chunkSize;
  if (status?.last_chunk && status.chunks_total && status.chunks_received < status.chunks_total) {
    return status.last_chunk.size;
  }
  return CHUNK_SIZE;
};

async function accessToken() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function loadUnfinished(userId: string): Promise<UnfinishedUpload[]> {
  const token = await accessToken();
  if (!token) return [];
  const dismissed = new Set(readDismissed());
  const fromServer = await listUnfinishedUploads(token);
  const local = new Map(pendingUploadsFor(userId).map((upload) => [upload.uploadId, upload]));
  const found: UnfinishedUpload[] = fromServer.map((status) => ({
    uploadId: status.upload_id,
    fileName: String(status.contract?.file_name ?? local.get(status.upload_id)?.fileName ?? "Unknown file"),
    local: local.get(status.upload_id),
    status,
  }));
  // Uploads this browser remembers that the server no longer lists: not started,
  // finished without processing, or expired.
  for (const upload of local.values()) {
    if (found.some((item) => item.uploadId === upload.uploadId)) continue;
    const status = await fetchUploadStatus(upload.uploadId, token);
    found.push({ uploadId: upload.uploadId, fileName: upload.fileName, local: upload, status });
  }
  return found.filter((upload) => !dismissed.has(upload.uploadId) && !isUploadActive(upload.uploadId));
}

export default function UnfinishedUploads() {
  const { user } = useAuth();
  const { track } = useAnalytics("profile");
  const runUpload = useResumableUpload("profile");
  const [uploads, setUploads] = useState<UnfinishedUpload[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const continuing = useRef<UnfinishedUpload | null>(null);

  const refresh = useCallback(() => {
    if (!user) return;
    loadUnfinished(user.id)
      .then(setUploads)
      .catch((error) => console.warn("Could not load unfinished uploads", error));
  }, [user]);

  useEffect(() => {
    refresh();
    window.addEventListener(UPLOADS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(UPLOADS_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  const transferProperties = (upload: UnfinishedUpload) => ({
    upload_type: String(upload.status?.contract?.upload_type ?? upload.local?.metadata.upload_type ?? ""),
    chunk_index: upload.status?.chunks_received ?? 0,
    chunks_total: upload.status?.chunks_total ?? 0,
    file_size_mb: Math.round((upload.local?.fileSize ?? 0) / 1024 ** 2),
  });

  const discard = (upload: UnfinishedUpload) => {
    dismiss(upload.uploadId);
    removePendingUpload(upload.uploadId);
    track("upload_discarded", transferProperties(upload));
    setUploads((current) => current.filter((item) => item.uploadId !== upload.uploadId));
  };

  const startProcessing = async (upload: UnfinishedUpload) => {
    const datasetId = Number(upload.status?.response?.id);
    const token = await accessToken();
    if (!upload.local || !datasetId || !token) return;
    try {
      await addProcess(datasetId, upload.local.processingSteps, token);
      removePendingUpload(upload.uploadId);
      message.success("Processing started.");
      refresh();
    } catch {
      message.error("Processing could not be started. Please try again.");
    }
  };

  const pickFile = (upload: UnfinishedUpload) => {
    continuing.current = upload;
    fileInput.current?.click();
  };

  const onFilePicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    const upload = continuing.current;
    continuing.current = null;
    if (!file || !upload) return;
    const contract = upload.status?.contract;
    const chunkSize = chunkSizeOf(upload);
    const sameFile =
      file.name === upload.fileName &&
      (upload.local ? file.size === upload.local.fileSize : chunkCount(file.size, chunkSize) === upload.status?.chunks_total);
    if (!sameFile) {
      message.error(`Please pick ${upload.fileName}, the file this upload started with.`);
      return;
    }
    const metadata = upload.local?.metadata ?? (contract ? contractMetadata(contract) : null);
    if (!metadata) {
      message.error("This upload was started with an older version of the site and cannot be continued.");
      return;
    }
    const uploadType = String(metadata.upload_type ?? contract?.upload_type ?? "");
    await runUpload({
      file,
      uploadId: upload.uploadId,
      metadata,
      uploadType,
      chunkSize,
      processingSteps: upload.local?.processingSteps ?? processingStepsFor(uploadType),
      resumed: true,
    });
  };

  if (!uploads.length) return null;

  return (
    <div className="mb-4 flex flex-col gap-2" data-testid="unfinished-uploads">
      <input ref={fileInput} type="file" accept=".tif,.tiff,.zip" className="hidden" onChange={onFilePicked} />
      {uploads.map((upload) => {
        const status = upload.status;
        const total = upload.local?.fileSize;
        const received = status?.bytes_received ?? 0;
        const percent = total ? Math.floor((received / total) * 100) : status?.chunks_total
          ? Math.floor((status.chunks_received / status.chunks_total) * 100)
          : 0;
        const discardButton = (
          <Popconfirm
            title="Discard this upload?"
            description="The part already uploaded is removed from our server within 7 days. To add this file later, you upload it again from the start."
            okText="Discard"
            onConfirm={() => discard(upload)}
          >
            <Button size="small">Discard</Button>
          </Popconfirm>
        );

        if (status?.state === "finalizing") {
          return (
            <Alert
              key={upload.uploadId}
              type="error"
              showIcon
              message={`Upload of ${upload.fileName} needs our help`}
              description="All data arrived, but the upload stopped while it was being finished. Please contact info@deadtrees.earth before you upload this file again."
            />
          );
        }
        if (status?.state === "complete") {
          return (
            <Alert
              key={upload.uploadId}
              type="warning"
              showIcon
              message={`${upload.fileName} is uploaded, but processing has not started`}
              action={
                <Space>
                  <Button size="small" type="primary" onClick={() => startProcessing(upload)}>
                    Start processing
                  </Button>
                </Space>
              }
            />
          );
        }
        if (status?.state === "expired") {
          return (
            <Alert
              key={upload.uploadId}
              type="error"
              showIcon
              message={`Upload of ${upload.fileName} expired`}
              description="It was paused for more than 7 days, so its data was removed. Please upload the file again."
              action={discardButton}
            />
          );
        }
        return (
          <Alert
            key={upload.uploadId}
            type="warning"
            showIcon
            message={`Unfinished upload: ${upload.fileName}`}
            description={
              `${percent} % uploaded` +
              (total ? ` (${formatSize(received)} of ${formatSize(total)})` : "") +
              (status ? `, stopped ${new Date(status.updated_at * 1000).toLocaleString()}` : "") +
              ". Pick the same file to continue where it stopped."
            }
            action={
              <Space direction="vertical" align="end">
                <Button size="small" type="primary" onClick={() => pickFile(upload)}>
                  Continue upload
                </Button>
                {discardButton}
              </Space>
            }
          />
        );
      })}
    </div>
  );
}
