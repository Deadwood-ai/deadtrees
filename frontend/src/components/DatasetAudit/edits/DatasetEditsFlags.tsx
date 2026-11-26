import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Drawer } from "antd";
import type { IDataset } from "../../../types/dataset";
import { DatasetDetailsMapProvider, SATELLITE_MAP_STYLE } from "../../../hooks/useDatasetDetailsMapProvider";
import { useDatasetFlags, useUpdateFlagStatus } from "../../../hooks/useDatasetFlags";
import { useAnalytics } from "../../../hooks/useAnalytics";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { MAP_AUDIT_SIDEBAR_WIDTH_CLASS, MAP_FLOATING_TOP_CLASS } from "../../../theme/mapLayout";
import EditingSidebar from "../../DatasetDetailsMap/EditingSidebar";
import AuditHeader from "../AuditHeader";
import UserFlagsCard from "../UserFlagsCard";
import EditsMap from "./EditsMap";

/** The Edits & flags page of one dataset (Other on the audit page): the issues users reported,
 * the edits they suggested to the predictions, and editing a prediction yourself. Not part of the
 * audit: nothing here changes or waits for the Audit Review. */
export default function DatasetEditsFlags({ dataset }: { dataset: IDataset }) {
	const isMobile = useIsMobile();
	const navigate = useNavigate();
	const { track } = useAnalytics("audit");
	const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
	const [editingLayer, setEditingLayer] = useState<"deadwood" | "forest_cover" | null>(null);
	const onEditingStateChange = useCallback((isEditing: boolean, layer: "deadwood" | "forest_cover" | null) => setEditingLayer(isEditing ? layer : null), []);
	const { data: flags = [], isLoading: isFlagsLoading } = useDatasetFlags(dataset.id);
	const { mutateAsync: updateFlagStatus, isPending: isUpdatingFlag } = useUpdateFlagStatus();

	useEffect(() => {
		track("correction_review_started", { dataset_id: dataset.id, review_scope: "dataset" });
	}, [dataset.id, track]);

	const sidebarContent = editingLayer ? (
		<div className="flex-1 overflow-y-auto p-2">
			<EditingSidebar layerType={editingLayer} />
		</div>
	) : (
		<>
			<AuditHeader title="Edits & flags" dataset={dataset} onCancel={() => navigate("/dataset-audit?tab=edits-flags")} />
			<div className="flex-1 overflow-y-auto p-2">
				<UserFlagsCard flags={flags} isFlagsLoading={isFlagsLoading} isUpdatingFlag={isUpdatingFlag} datasetId={dataset.id} onUpdateFlag={updateFlagStatus} />
				<div className="px-1 text-xs text-gray-600">
					Edits users suggested show on the map: click one to approve or revert it. To edit a prediction yourself, use Edit in the layer panel.
				</div>
			</div>
		</>
	);

	return (
		<div className="relative flex h-screen w-full overflow-hidden bg-slate-50" data-testid="edits-flags-page">
			{!isMobile && (
				<div
					className={`absolute bottom-6 left-4 ${MAP_FLOATING_TOP_CLASS} pointer-events-auto z-10 flex ${MAP_AUDIT_SIDEBAR_WIDTH_CLASS} flex-shrink-0 flex-col overflow-hidden rounded-2xl border border-gray-200/60 bg-white/95 shadow-xl backdrop-blur-sm`}
				>
					{sidebarContent}
				</div>
			)}

			<DatasetDetailsMapProvider initial={{ mapStyle: SATELLITE_MAP_STYLE }}>
				<div className="absolute inset-0 z-0">
					<EditsMap dataset={dataset} onEditingStateChange={onEditingStateChange} />
				</div>
			</DatasetDetailsMapProvider>

			{isMobile && (
				<>
					<div className="absolute left-2 top-20 z-20">
						<Button type="primary" onClick={() => setIsMobileSidebarOpen(true)}>
							Edits & flags
						</Button>
					</div>
					<Drawer title="Edits & flags" placement="left" width="92vw" open={isMobileSidebarOpen} onClose={() => setIsMobileSidebarOpen(false)}>
						<div className="flex h-full flex-col">{sidebarContent}</div>
					</Drawer>
				</>
			)}
		</div>
	);
}
