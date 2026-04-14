import { useRef, useState } from "react";
import { Form, message, Button, Drawer } from "antd";
import { IDataset } from "../../types/dataset";
import { DatasetDetailsMapProvider } from "../../hooks/useDatasetDetailsMapProvider";
import { useAuditDetailState } from "./useAuditDetailState";
import { Settings } from "../../config";
import { DatasetSeasonInfo } from "../../hooks/useSeasonPrompt";
import EditingSidebar from "../DatasetDetailsMap/EditingSidebar";
import { supabase } from "../../hooks/useSupabase";
import { useAuth } from "../../hooks/useAuthProvider";

// Sub-components
import AuditHeader from "./AuditHeader";
import { AuditFooterFormItem } from "./AuditFooter";
import {
	UserFlagsCard,
	GeoreferencingCard,
	AcquisitionDateCard,
	PhenologyCard,
	PredictionQualityCard,
	COGQualityCard,
	ThumbnailCard,
	AOICard,
	FinalAssessmentCard,
} from "./AuditStepCards";
import AuditMapWithControls, { AuditMapWithControlsHandle } from "./AuditMapWithControls";
import { MAP_AUDIT_SIDEBAR_WIDTH_CLASS, MAP_FLOATING_TOP_CLASS } from "../../theme/mapLayout";
import { resolveDownloadUrl } from "../../utils/downloadUrl";
import { useIsMobile } from "../../hooks/useIsMobile";

interface DatasetAuditDetailProps {
	dataset: IDataset;
}

interface DownloadApiResponse {
	status?: string;
	job_id?: string;
	download_path?: string;
	message?: string;
	detail?: string;
}

/**
 * DatasetAuditDetail - Main audit detail view
 * 
 * Refactored to use extracted components:
 * - AuditMapWithControls: Map + layer controls + correction review
 * - AuditStepCards: Individual audit form sections
 * - useAuditDetailState: All state management logic
 */
export default function DatasetAuditDetail({ dataset }: DatasetAuditDetailProps) {
	const { session } = useAuth();
	const isMobile = useIsMobile();
	// Map ref for map controls (zoom, flash, refresh)
	const mapRef = useRef<AuditMapWithControlsHandle>(null);

	// Editing state (tracked from child map component)
	const [isPolygonEditing, setIsPolygonEditing] = useState(false);
	const [editingLayerType, setEditingLayerType] = useState<"deadwood" | "forest_cover" | null>(null);
	const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

	// Handle editing state changes from map component
	const handleEditingStateChange = (isEditing: boolean, layerType: "deadwood" | "forest_cover" | null) => {
		setIsPolygonEditing(isEditing);
		setEditingLayerType(layerType);
	};

	// Use the custom hook for all state and logic
	const {
		form,
		handleSubmit,
		handleSaveAndNext,
		handleCancel,
		handleMarkReviewedAndNext,
		isLoading,
		isSaving,
		isPending,
		isReviewed,
		auditLockError,
		isLockingAudit,
		navigateToNext,
		auditData,
		flags,
		isFlagsLoading,
		orthoMetadata,
		isOrthoLoading,
		phenologyData,
		isPhenologyLoading,
		updateFlagStatus,
		isUpdatingFlag,
		nextDatasetId,
		currentDatasetIndex,
		totalCount,
		isMarkingReviewed,
		hasAOI,
		handleAOIChange,
		aoiToolbarState,
		setAoiToolbarState,
		isDownloading,
		startDownload,
		finishDownload,
		currentDownloadId,
		copyPromptWithImage,
	} = useAuditDetailState({ dataset });

	// Generate thumbnail URL
	const thumbnailUrl = dataset.thumbnail_path ? `${Settings.THUMBNAIL_URL}${dataset.thumbnail_path}` : null;

	// Handle season prompt copy
	const handleCopySeasonPrompt = () => {
		if (!thumbnailUrl) {
			message.warning("No thumbnail available for prompt");
			return;
		}
		const seasonInfo: DatasetSeasonInfo = {
			country: dataset.admin_level_1 || undefined,
			admin_level_2: dataset.admin_level_2 || undefined,
			admin_level_3: dataset.admin_level_3 || undefined,
			biome_name: dataset.biome_name || undefined,
			acquisition_date: dataset.aquisition_year
				? `${dataset.aquisition_year}-${dataset.aquisition_month || "01"}-${dataset.aquisition_day || "01"}`
				: undefined,
		};
		copyPromptWithImage(seasonInfo, thumbnailUrl);
	};

	// Handle orthophoto download
	const handleStartDownload = (ds: IDataset) => {
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
								window.location.href = downloadUrl;
								message.success("Download started!");
								finishDownload();
							} else if (statusData.status === "failed") {
								downloadMsg();
								message.error(`Download failed: ${statusData.message || "Unknown error"}`);
								finishDownload();
							} else {
								setTimeout(checkStatus, 2000);
							}
						})
						.catch(() => {
							downloadMsg();
							message.error("Failed to check download status");
							finishDownload();
						});
				};

				checkStatus();
			})
			.catch((error: Error) => {
				downloadMsg();
				message.error(error?.message || "Failed to initiate download");
				finishDownload();
			});
	};

	// Show loading state
	if (isLoading) {
		return (
			<div className="flex h-full w-full items-center justify-center">
				<div className="text-center">
					<div className="mb-2">Loading audit...</div>
					{isLockingAudit && <div className="text-sm text-gray-500">Securing audit lock...</div>}
				</div>
			</div>
		);
	}

	// Show error state
	if (auditLockError) {
		return (
			<div className="flex h-full w-full items-center justify-center">
				<div className="text-center">
					<div className="mb-2 text-red-600">{auditLockError}</div>
					<div className="text-sm text-gray-500">Redirecting to audit list...</div>
				</div>
			</div>
		);
	}

	const sidebarContent = (
		<>
			{/* Header - hidden when editing */}
			{!isPolygonEditing && (
				<AuditHeader dataset={dataset} auditData={auditData} onCancel={handleCancel} />
			)}

			{/* Scrollable Content */}
			<div className="flex-1 overflow-y-auto p-2">
				{isPolygonEditing && editingLayerType ? (
					<EditingSidebar layerType={editingLayerType} />
				) : (
					<Form
						form={form}
						layout="vertical"
						onFinish={handleSubmit}
						disabled={isLoading}
						size="small"
						validateTrigger={["onChange", "onBlur"]}
					>
						<UserFlagsCard
							flags={flags}
							isFlagsLoading={isFlagsLoading}
							isUpdatingFlag={isUpdatingFlag}
							datasetId={dataset.id}
							onUpdateFlag={updateFlagStatus}
						/>

						<GeoreferencingCard />

						<AcquisitionDateCard dataset={dataset} />

						<PhenologyCard
							dataset={dataset}
							phenologyData={phenologyData}
							isPhenologyLoading={isPhenologyLoading}
							onCopySeasonPrompt={handleCopySeasonPrompt}
						/>

						<PredictionQualityCard />

						<COGQualityCard />

						<ThumbnailCard thumbnailUrl={thumbnailUrl} />

						<AOICard aoiToolbarState={aoiToolbarState} mapRef={mapRef} />

						<FinalAssessmentCard
							dataset={dataset}
							orthoMetadata={orthoMetadata}
							isOrthoLoading={isOrthoLoading}
							isDownloading={isDownloading}
							currentDownloadId={currentDownloadId}
							onStartDownload={handleStartDownload}
						/>

						{/* Footer Actions */}
						<div className="sticky bottom-0 z-10 -mx-2 border-t border-slate-200 bg-white p-3">
							<AuditFooterFormItem
								hasAOI={hasAOI}
								isPending={isPending}
								isReviewed={isReviewed}
								reviewedByEmail={auditData?.reviewed_by_email}
								nextDatasetId={nextDatasetId}
								currentDatasetIndex={currentDatasetIndex}
								totalCount={totalCount}
								isSaving={isSaving}
								navigateToNext={navigateToNext}
								isMarkingReviewed={isMarkingReviewed}
								onCancel={handleCancel}
								onSave={() => form.submit()}
								onSaveAndNext={handleSaveAndNext}
								onMarkReviewedAndNext={handleMarkReviewedAndNext}
							/>
						</div>
					</Form>
				)}
			</div>
		</>
	);

	return (
		<div className="relative flex h-screen w-full overflow-hidden bg-slate-50">
			{/* Sidebar */}
			{!isMobile && (
				<div
					className={`absolute bottom-6 left-4 ${MAP_FLOATING_TOP_CLASS} z-10 flex ${MAP_AUDIT_SIDEBAR_WIDTH_CLASS} flex-shrink-0 flex-col overflow-hidden rounded-2xl border border-gray-200/60 bg-white/95 shadow-xl backdrop-blur-sm pointer-events-auto`}
				>
					{sidebarContent}
				</div>
			)}

			{/* Map - wrapped in provider for layer controls */}
			<DatasetDetailsMapProvider>
				<div className="absolute inset-0 z-0">
					<AuditMapWithControls
						ref={mapRef}
						dataset={dataset}
						onAOIChange={handleAOIChange}
						onToolbarStateChange={setAoiToolbarState}
						onEditingStateChange={handleEditingStateChange}
					/>
				</div>
			</DatasetDetailsMapProvider>

			{isMobile && (
				<>
					<div className="absolute left-2 top-20 z-20">
						<Button type="primary" onClick={() => setIsMobileSidebarOpen(true)}>
							Audit Form
						</Button>
					</div>
					<Drawer
						title="Audit form"
						placement="left"
						width="92vw"
						open={isMobileSidebarOpen}
						onClose={() => setIsMobileSidebarOpen(false)}
					>
						<div className="flex h-full flex-col">{sidebarContent}</div>
					</Drawer>
				</>
			)}
		</div>
	);
}
