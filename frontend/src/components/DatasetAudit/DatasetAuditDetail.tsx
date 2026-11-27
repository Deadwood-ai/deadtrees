import { useRef, useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Form, message, Button, Drawer } from "antd";
import { useDatasetThumbnailUrl } from "../../hooks/useDatasetAccess";
import { IDataset } from "../../types/dataset";
import { AUDIT_MAP_START, DatasetDetailsMapProvider } from "../../hooks/useDatasetDetailsMapProvider";
import { useAuditDetailState } from "./useAuditDetailState";
import { useOrthoDownload } from "./useOrthoDownload";
import AuditHeader from "./AuditHeader";
import { MapPageSkeleton } from "../PageSkeletons";
import AuditFooter from "./AuditFooter";
import AuditSections from "./checks/AuditSections";
import { INITIAL_CHECK_VIEW, STEP_ORDER, nextStep, openStep, type IAuditCheckView } from "./checks/auditCheckView";
import { AUDIT_SECTIONS, auditSection, type AuditSectionId } from "../../utils/auditChecks";
import { AuditLockBlocked, AuditLockLostNotice, AuditOpenElsewhere } from "./AuditLockNotices";
import AuditMapWithControls, { AuditMapWithControlsHandle } from "./AuditMapWithControls";
import { MAP_AUDIT_SIDEBAR_WIDTH_CLASS, MAP_FLOATING_TOP_CLASS } from "../../theme/mapLayout";
import { useIsMobile } from "../../hooks/useIsMobile";

interface DatasetAuditDetailProps {
	dataset: IDataset;
}

/**
 * The Audit Review of one dataset:
 * - AuditSections: what still needs a person and the seven steps, in the sidebar
 * - AuditMapWithControls: map, layer controls and the open step's map mode
 * - useAuditDetailState: the results, the reviewer's draft, the lease and Save
 * User reports and suggested edits are not part of the audit: they have the Edits & flags page.
 */
export default function DatasetAuditDetail({ dataset }: DatasetAuditDetailProps) {
	const isMobile = useIsMobile();
	const mapRef = useRef<AuditMapWithControlsHandle>(null);
	const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

	const state = useAuditDetailState({ dataset });
	const { form, aoi, auditChecks, auditLeaseId, auditLockLostMessage } = state;
	const startDownload = useOrthoDownload(state);
	const thumbnailUrl = useDatasetThumbnailUrl(dataset);

	// The open step; ?section= opens one
	const [searchParams] = useSearchParams();
	const requestedSection = searchParams.get("section");
	const initialView = useCallback(
		(): IAuditCheckView => ({
			...INITIAL_CHECK_VIEW,
			section: AUDIT_SECTIONS.some((s) => s.id === requestedSection) ? (requestedSection as AuditSectionId) : null,
		}),
		[requestedSection],
	);
	const [checkView, setCheckView] = useState<IAuditCheckView>(initialView);
	const updateCheckView = useCallback((patch: Partial<IAuditCheckView>) => setCheckView((v) => ({ ...v, ...patch })), []);
	useEffect(() => setCheckView(initialView()), [dataset.id, initialView]);
	const openSection = checkView.section ? auditSection(checkView.section) : null;

	if (state.isLoading) {
		return <MapPageSkeleton label={state.isLockingAudit ? "Securing the review lock" : "Loading the review"} />;
	}

	if (state.auditLockError) {
		return (
			<AuditLockBlocked message={state.auditLockError}>
				<div className="text-sm text-gray-500">Redirecting to the Audit Review list...</div>
			</AuditLockBlocked>
		);
	}

	if (state.auditOpenElsewhereMessage) {
		return <AuditOpenElsewhere message={state.auditOpenElsewhereMessage} onBack={state.handleCancel} onContinueHere={state.continueAuditHere} />;
	}

	const sidebarContent = (
		<>
			<AuditHeader title="Audit Review" dataset={dataset} onCancel={state.handleCancel} />

			<div className="flex-1 overflow-y-auto p-2">
				<Form
					form={form}
					layout="vertical"
					onFinish={state.handleSubmit}
					onFinishFailed={({ errorFields }) => message.error(errorFields[0]?.errors[0] ?? "Some answers are missing")}
					disabled={!!auditLockLostMessage || !auditLeaseId}
					size="small"
				>
					<AuditSections
						dataset={dataset}
						checks={auditChecks}
						checksFailed={state.auditChecksFailed}
						onRetryChecks={state.retryChecks}
						reviews={state.auditReviews}
						result={state.result}
						resultFailed={state.resultFailed}
						hasAOI={aoi.hasAOI && !aoi.isDirty}
						view={checkView}
						setView={updateCheckView}
						panels={{
							cog: {
								dataset,
								cog: state.cogMetadata,
								isLoading: state.isCogLoading,
								isDownloading: state.isDownloading,
								currentDownloadId: state.currentDownloadId,
								onStartDownload: startDownload,
							},
							thumbnailUrl,
							aoi: {
								aoiToolbarState: aoi.toolbarState,
								mapRef,
								isDirty: aoi.isDirty,
								isSaving: aoi.isSaving,
								onSaveAOI: aoi.handleSave,
							},
							georefCheck: state.georefCheck,
							dateEstimate: state.dateEstimate,
						}}
					/>

					<div className="sticky bottom-0 z-10 -mx-2 border-t border-slate-200 bg-white p-3">
						{auditLockLostMessage ? (
							<AuditLockLostNotice message={auditLockLostMessage} onBack={state.handleCancel} />
						) : (
							<AuditFooter
								nextDatasetId={state.nextDatasetId}
								isSaving={state.isSaving}
								isAOIBusy={aoi.isDirty || aoi.isSaving}
								onCancel={state.handleCancel}
								onSave={() => form.submit()}
								onSaveAndNext={() => state.handleSaveAndNext(checkView.section)}
							/>
						)}
					</div>
				</Form>
			</div>
		</>
	);

	return (
		<div className="relative flex h-screen w-full overflow-hidden bg-slate-50">
			{!isMobile && (
				<div
					className={`absolute bottom-6 left-4 ${MAP_FLOATING_TOP_CLASS} z-10 flex ${MAP_AUDIT_SIDEBAR_WIDTH_CLASS} flex-shrink-0 flex-col overflow-hidden rounded-2xl border border-gray-200/60 bg-white/95 shadow-xl backdrop-blur-sm pointer-events-auto`}
				>
					{sidebarContent}
				</div>
			)}

			<DatasetDetailsMapProvider initial={AUDIT_MAP_START}>
				<div className="absolute inset-0 z-0">
					<AuditMapWithControls
						ref={mapRef}
						dataset={dataset}
						onAOIChange={aoi.handleChange}
						onToolbarStateChange={aoi.setToolbarState}
						checkMap={{
							section: openSection,
							georefCheck: state.georefCheck ?? null,
							evidence: openSection?.checkKey ? auditChecks?.checks[openSection.checkKey] : undefined,
							cropId: checkView.cropId,
							onSelectCrop: (cropId) => updateCheckView({ cropId }),
							cropReview: {
								datasetId: dataset.id,
								reviews: state.auditReviews,
								judgements: auditChecks?.tileJudgements ?? [],
								disabled: !auditLeaseId,
								mapOnly: checkView.mapOnly,
								setMapOnly: (mapOnly) => updateCheckView({ mapOnly }),
								onNextStep: () => checkView.section && openStep(updateCheckView, nextStep(STEP_ORDER, checkView.section)),
							},
						}}
					/>
				</div>
			</DatasetDetailsMapProvider>

			{isMobile && (
				<>
					<div className="absolute left-2 top-20 z-20">
						<Button type="primary" onClick={() => setIsMobileSidebarOpen(true)}>
							Audit Review
						</Button>
					</div>
					<Drawer title="Audit Review" placement="left" width="92vw" open={isMobileSidebarOpen} onClose={() => setIsMobileSidebarOpen(false)}>
						<div className="flex h-full flex-col">{sidebarContent}</div>
					</Drawer>
				</>
			)}
		</div>
	);
}
