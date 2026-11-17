// Uploads that stopped before the end, with a way to continue each one. The
// server lists what it holds; this browser adds the uploads it remembers. A
// contributor has to pick the file again, because browsers forget file access
// when a tab closes. The panel has no close button on purpose: an upload leaves
// it only by finishing or by an explicit, confirmed discard.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Popconfirm, Space, message } from "antd";
import { useAuth } from "../../hooks/useAuthProvider";
import { useAnalytics } from "../../hooks/useAnalytics";
import { getAccessToken, useResumableUpload } from "../../hooks/useResumableUpload";
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
  discardUpload,
  discardedUploadIds,
  isSameFile,
  uploadsRunningInAnyTab,
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

/**
 * The chunk size the upload was started with (the web app uses 50 MiB, the CLI
 * 100 MiB); all chunks but the last share it. Without a local record it follows
 * from the received chunks, or from the chunk count before any arrived.
 */
const chunkSizeOf = (upload: UnfinishedUpload, file: File) => {
  if (upload.local) return upload.local.chunkSize;
  const { chunks_received: received = 0, bytes_received: bytes = 0, last_chunk: last, chunks_total: total } =
    upload.status ?? {};
  if (received >= 2 && last) return (bytes - last.size) / (received - 1);
  if (received === 1 && last && total !== 1) return last.size;
  if (!total || chunkCount(file.size, CHUNK_SIZE) === total) return CHUNK_SIZE;
  return Math.ceil(file.size / total);
};

// A focus right after a load does not reload again.
const REFRESH_INTERVAL_MS = 30_000;

async function loadUnfinished(userId: string): Promise<UnfinishedUpload[]> {
  const token = await getAccessToken();
  const discarded = discardedUploadIds();
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
  const unlisted = [...local.values()].filter((upload) => !found.some((item) => item.uploadId === upload.uploadId));
  // One failed lookup leaves out only that upload, not the whole list.
  const statuses = await Promise.allSettled(unlisted.map((upload) => fetchUploadStatus(upload.uploadId, token)));
  unlisted.forEach((upload, index) => {
    const result = statuses[index];
    if (result.status === "fulfilled") {
      found.push({ uploadId: upload.uploadId, fileName: upload.fileName, local: upload, status: result.value });
    }
  });
  const running = await uploadsRunningInAnyTab();
  return found.filter((upload) => !discarded.has(upload.uploadId) && !running.has(upload.uploadId));
}

export default function UnfinishedUploads() {
  const { user } = useAuth();
  const { track } = useAnalytics("profile");
  const runUpload = useResumableUpload("profile");
  const [uploads, setUploads] = useState<UnfinishedUpload[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const continuing = useRef<UnfinishedUpload | null>(null);
  const lastLoad = useRef({ id: 0, at: 0 });

  const refresh = useCallback(() => {
    if (!user) return;
    // Only the newest load may set the list, so a slow older reply never overwrites it.
    const load = { id: lastLoad.current.id + 1, at: Date.now() };
    lastLoad.current = load;
    loadUnfinished(user.id)
      .then((found) => lastLoad.current.id === load.id && setUploads(found))
      .catch((error) => console.warn("Could not load unfinished uploads", error));
  }, [user]);

  useEffect(() => {
    const onFocus = () => Date.now() - lastLoad.current.at > REFRESH_INTERVAL_MS && refresh();
    refresh();
    window.addEventListener(UPLOADS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener(UPLOADS_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const transferProperties = (upload: UnfinishedUpload) => ({
    upload_type: String(upload.status?.contract?.upload_type ?? upload.local?.metadata.upload_type ?? ""),
    chunk_index: upload.status?.chunks_received ?? 0,
    chunks_total: upload.status?.chunks_total ?? 0,
    file_size_mb: Math.round((upload.local?.fileSize ?? 0) / 1024 ** 2),
  });

  const discard = (upload: UnfinishedUpload) => {
    discardUpload(upload.uploadId);
    track("upload_discarded", transferProperties(upload));
    setUploads((current) => current.filter((item) => item.uploadId !== upload.uploadId));
  };

  const startProcessing = async (upload: UnfinishedUpload) => {
    const datasetId = Number(upload.status?.response?.id);
    if (!upload.local || !datasetId) return;
    try {
      await addProcess(datasetId, upload.local.processingSteps, await getAccessToken());
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
    const metadata = upload.local?.metadata ?? (contract ? contractMetadata(contract) : null);
    if (!metadata) {
      message.error("This upload was started with an older version of the site and cannot be continued.");
      return;
    }
    const chunkSize = chunkSizeOf(upload, file);
    const sameFile = upload.local
      ? isSameFile(upload.local, file)
      : file.name === upload.fileName && chunkCount(file.size, chunkSize) === upload.status?.chunks_total;
    if (!sameFile) {
      message.error(`Please pick ${upload.fileName}, the file this upload started with.`);
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
