import { message } from "antd";
import { IDataset } from "../../types/dataset";
import { Settings } from "../../config";
import { supabase } from "../../hooks/useSupabase";
import { useAuth } from "../../hooks/useAuthProvider";
import { useAnalytics } from "../../hooks/useAnalytics";
import { resolveDownloadUrl } from "../../utils/downloadUrl";

interface DownloadApiResponse {
	status?: string;
	job_id?: string;
	download_path?: string;
	message?: string;
	detail?: string;
}

interface OrthoDownloadState {
	isDownloading: boolean;
	currentDownloadId: string | null;
	startDownload: (id: string) => boolean;
	finishDownload: () => void;
}

/** The orthophoto download of the review page: starts the API job, polls its status and opens the
 * file when it is ready. Returns the handler for a dataset. */
export function useOrthoDownload({ isDownloading, currentDownloadId, startDownload, finishDownload }: OrthoDownloadState) {
	const { session } = useAuth();
	const { track } = useAnalytics("audit");
	return (ds: IDataset) => {
		if (!session) {
			message.info("Please log in to download datasets.");
			return;
		}

		if (ds.data_access === "viewonly") {
			message.warning("This is a view-only dataset. Orthophoto download is restricted.");
			return;
		}

		if (isDownloading) {
			if (currentDownloadId !== `${ds.id}-ortho`) {
				message.info("A download is already in progress. Please wait.");
			}
			return;
		}

		const downloadStarted = startDownload(`${ds.id}-ortho`);
		if (!downloadStarted) return;
		track("dataset_download_started", {
			dataset_id: ds.id,
			download_type: "orthophoto",
		});

		const baseUrl = `${Settings.API_URL}/download/datasets/${ds.id}/dataset.zip`;

		const downloadMsg = message.loading({
			content: "Preparing orthophoto for download...",
			duration: 0,
		});

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

		supabase.auth
			.getSession()
			.then(({ data: authData }) => {
				const accessToken = authData.session?.access_token;
				if (!accessToken) {
					throw new Error("Authentication required for download");
				}
				const headers = { Authorization: `Bearer ${accessToken}` };
				return fetch(baseUrl, { headers })
					.then(parseJsonResponse)
					.then((data) => ({ data, headers }));
			})
			.then(({ data, headers }) => {
				const jobId = data.job_id;
				if (!jobId) {
					throw new Error("Missing job ID in download response");
				}
				const downloadEndpoint = `${Settings.API_URL}/download/datasets/${jobId}/download`;

				const checkStatus = () => {
					fetch(`${Settings.API_URL}/download/datasets/${jobId}/status`, { headers })
						.then(parseJsonResponse)
						.then((statusData) => {
							if (statusData.status === "completed") {
								const downloadUrl = resolveDownloadUrl(statusData.download_path, downloadEndpoint);
								if (!downloadUrl) {
									throw new Error("Missing download URL in status response");
								}

								downloadMsg();
								track("dataset_download_completed", {
									dataset_id: ds.id,
									download_type: "orthophoto",
								});
								window.location.href = downloadUrl;
								message.success("Download started!");
								finishDownload();
							} else if (statusData.status === "failed") {
								downloadMsg();
								track("dataset_download_failed", {
									dataset_id: ds.id,
									download_type: "orthophoto",
									failure_reason: statusData.message || "preparation_failed",
								});
								message.error(`Download failed: ${statusData.message || "Unknown error"}`);
								finishDownload();
							} else {
								setTimeout(checkStatus, 2000);
							}
						})
						.catch(() => {
							downloadMsg();
							track("dataset_download_failed", {
								dataset_id: ds.id,
								download_type: "orthophoto",
								failure_reason: "status_check_failed",
							});
							message.error("Failed to check download status");
							finishDownload();
						});
				};

				checkStatus();
			})
			.catch((error: Error) => {
				downloadMsg();
				track("dataset_download_failed", {
					dataset_id: ds.id,
					download_type: "orthophoto",
					failure_reason: error?.message || "start_failed",
				});
				message.error(error?.message || "Failed to initiate download");
				finishDownload();
			});
	};
}
