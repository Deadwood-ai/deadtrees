import { useCallback, useEffect, useRef } from "react";
import { message, Tag, Tooltip } from "antd";
import { EditOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { useQueryClient } from "@tanstack/react-query";
import type { Map as OLMap } from "ol";
import type TileLayerWebGL from "ol/layer/WebGLTile.js";

import { IDataset } from "../../../types/dataset";
import DatasetAuditMap, { DatasetAuditMapHandle } from "../DatasetAuditMap";
import DatasetLayerControlPanel from "../../DatasetDetailsMap/DatasetLayerControlPanel";
import EditorToolbar from "../../PolygonEditor/EditorToolbar";
import { useDatasetDetailsMap } from "../../../hooks/useDatasetDetailsMapProvider";
import { useDatasetLabelTypes } from "../../../hooks/useDatasetLabelTypes";
import { useApproveCorrection, useRevertCorrection } from "../../../hooks/useSaveCorrections";
import { useCorrectionStats, useCorrectionContributors, usePendingCorrectionLocations } from "../../../hooks/usePendingCorrections";
import { useAuth } from "../../../hooks/useAuthProvider";
import { useDatasetEditing } from "../../../hooks/useDatasetEditing";
import { mapColors } from "../../../theme/mapColors";
import { MAP_FLOATING_TOP_CLASS } from "../../../theme/mapLayout";
import { trackAppEvent } from "../../../utils/analytics";
import { hasForestCoverPredictionOutput } from "../../../utils/predictionAvailability";

interface EditsMapProps {
	dataset: IDataset;
	onEditingStateChange: (isEditing: boolean, layerType: "deadwood" | "forest_cover" | null) => void;
}

/** The map of the Edits & flags page: the predictions with the edits users suggested, each to
 * approve or revert, the review progress, and editing a prediction yourself. Not part of the audit. */
export default function EditsMap({ dataset, onEditingStateChange }: EditsMapProps) {
	const mapRef = useRef<DatasetAuditMapHandle>(null);
	const { user } = useAuth();
	const { layerControl, setMapStyle, setShowForestCover, setShowDeadwood, setShowDroneImagery, setShowAOI, setLayerOpacity } = useDatasetDetailsMap();

	const { deadwood, forestCover } = useDatasetLabelTypes({ datasetId: dataset.id, enabled: true });
	const hasDeadwood = !!deadwood.data?.id;
	const hasForestCover = !!forestCover.data?.id && hasForestCoverPredictionOutput(dataset);

	const editing = useDatasetEditing({ datasetId: dataset.id, user });
	const { isEditing, editingLayerType, editor, ai, refreshKey } = editing;
	const startDeadwoodEdit = hasDeadwood ? () => editing.handleStartEditing("deadwood") : undefined;
	const startForestCoverEdit = hasForestCover ? () => editing.handleStartEditing("forest_cover") : undefined;
	useEffect(() => {
		onEditingStateChange(isEditing, editingLayerType);
	}, [isEditing, editingLayerType, onEditingStateChange]);

	const queryClient = useQueryClient();
	const { mutateAsync: approveCorrection } = useApproveCorrection();
	const { mutateAsync: revertCorrection } = useRevertCorrection();
	const { data: correctionStats } = useCorrectionStats(dataset.id);
	const { data: contributors } = useCorrectionContributors(dataset.id);
	const { data: pendingLocations } = usePendingCorrectionLocations(dataset.id);
	const pendingDeadwood = pendingLocations?.filter((p) => p.layerType === "deadwood").length ?? 0;
	const pendingForestCover = pendingLocations?.filter((p) => p.layerType === "forest_cover").length ?? 0;

	/** Approves or reverts one suggested edit, then reloads the edits and the map. */
	const review = (action: "approve" | "revert") => async (correctionId: number) => {
		const done = action === "approve" ? "approved" : "reverted";
		try {
			const result = await (action === "approve" ? approveCorrection : revertCorrection)({ correctionId });
			if (!result) {
				message.error(`Failed to ${action} correction`);
				return;
			}
			trackAppEvent(action === "approve" ? "correction_approved" : "correction_reverted", { dataset_id: dataset.id });
			message.success(`Correction ${done}`);
			for (const key of ["pendingCorrections", ["correctionStats", dataset.id], ["correctionContributors", dataset.id], ["pendingCorrectionLocations", dataset.id]]) {
				queryClient.invalidateQueries({ queryKey: Array.isArray(key) ? key : [key] });
			}
			mapRef.current?.refreshVectorLayers();
		} catch (error) {
			console.error(`Error: correction not ${done}:`, error);
			message.error(`Failed to ${action} correction`);
		}
	};

	/** Zooms to the pending edits (of one layer) and flashes each. */
	const flashPending = (layerType?: "deadwood" | "forest_cover") => {
		const shown = (pendingLocations ?? []).filter((p) => !layerType || p.layerType === layerType);
		if (!shown.length) return;
		mapRef.current?.zoomToExtent(
			Math.min(...shown.map((p) => p.minLon)),
			Math.min(...shown.map((p) => p.minLat)),
			Math.max(...shown.map((p) => p.maxLon)),
			Math.max(...shown.map((p) => p.maxLat)),
			50,
		);
		shown.forEach((loc, index) => setTimeout(() => mapRef.current?.flashLocation(loc.centroidLon, loc.centroidLat), index * 200));
	};

	const handleMapReady = useCallback((map: OLMap) => editing.handleMapReady(map), [editing]);
	const handleOrthoLayerReady = useCallback((layer: TileLayerWebGL) => editing.handleOrthoLayerReady(layer), [editing]);

	return (
		<div className="relative h-full w-full flex-1">
			{!isEditing && correctionStats && correctionStats.total > 0 && (
				<div className="pointer-events-auto absolute left-3 top-3 z-50 md:left-[calc(420px+2rem)] md:top-24">
					<div className="flex flex-col gap-1.5 rounded-lg bg-white/95 p-2.5 shadow-lg backdrop-blur-sm">
						<div className="mb-1 text-xs font-medium text-gray-600">Edit Review Progress</div>
						{correctionStats.pending > 0 ? (
							<>
								<Tooltip title="Click to zoom and flash all pending edits">
									<Tag icon={<EditOutlined />} color="orange" className="m-0 cursor-pointer hover:opacity-80" onClick={() => flashPending()}>
										{correctionStats.pending} pending
									</Tag>
								</Tooltip>
								<div className="ml-2 flex flex-col gap-1">
									{pendingDeadwood > 0 && (
										<Tooltip title="Click to show pending deadwood cover edits">
											<div className="flex cursor-pointer items-center gap-1.5 text-[10px] text-gray-600 hover:text-orange-600" onClick={() => flashPending("deadwood")}>
												<span className="h-2 w-2 rounded-sm" style={{ backgroundColor: mapColors.deadwood.fill }} />
												<span>{pendingDeadwood} deadwood cover</span>
											</div>
										</Tooltip>
									)}
									{pendingForestCover > 0 && (
										<Tooltip title="Click to show pending tree cover edits">
											<div className="flex cursor-pointer items-center gap-1.5 text-[10px] text-gray-600 hover:text-green-600" onClick={() => flashPending("forest_cover")}>
												<span className="h-2 w-2 rounded-sm bg-green-500" />
												<span>{pendingForestCover} tree cover</span>
											</div>
										</Tooltip>
									)}
								</div>
							</>
						) : (
							<Tooltip title="All edits have been reviewed">
								<Tag icon={<CheckCircleOutlined />} color="green" className="m-0">
									All reviewed
								</Tag>
							</Tooltip>
						)}
						{correctionStats.approved > 0 && (
							<Tag color="green" className="m-0">
								{correctionStats.approved} approved
							</Tag>
						)}
						{correctionStats.rejected > 0 && (
							<Tag color="default" className="m-0">
								{correctionStats.rejected} reverted
							</Tag>
						)}
						{contributors && contributors.length > 0 && (
							<div className="mt-1.5 border-t border-gray-200 pt-1.5">
								<div className="mb-1 text-[10px] text-gray-500">Contributors:</div>
								{contributors.slice(0, 3).map((contributor, idx) => (
									<div key={idx} className="truncate text-[10px] text-gray-600" title={contributor.email}>
										{contributor.email.split("@")[0]} ({contributor.count})
									</div>
								))}
								{contributors.length > 3 && <div className="text-[10px] text-gray-400">+{contributors.length - 3} more</div>}
							</div>
						)}
					</div>
				</div>
			)}

			{!isEditing && (
				<div className={`absolute right-4 ${MAP_FLOATING_TOP_CLASS} pointer-events-auto z-50`}>
					<DatasetLayerControlPanel
						mapStyle={layerControl.mapStyle}
						onMapStyleChange={setMapStyle}
						showForestCover={layerControl.showForestCover}
						setShowForestCover={setShowForestCover}
						showDeadwood={layerControl.showDeadwood}
						setShowDeadwood={setShowDeadwood}
						showDroneImagery={layerControl.showDroneImagery}
						setShowDroneImagery={setShowDroneImagery}
						showAOI={layerControl.showAOI}
						setShowAOI={setShowAOI}
						hasForestCover={hasForestCover}
						hasDeadwood={hasDeadwood}
						hasAOI={true}
						opacity={layerControl.layerOpacity}
						setOpacity={setLayerOpacity}
						onEditForestCover={startForestCoverEdit}
						onEditDeadwood={startDeadwoodEdit}
						isLoggedIn={true}
					/>
				</div>
			)}

			{isEditing && editingLayerType && (
				<EditorToolbar
					type={editingLayerType}
					isDrawing={editor.isDrawing}
					hasSelection={editor.selection.length > 0}
					selectionCount={editor.selection.length}
					isAIActive={ai.isActive}
					isAIProcessing={ai.isProcessing}
					onToggleDraw={() => editor.toggleDraw()}
					onCutHole={editor.cutHoleWithDrawn}
					onMerge={editor.mergeSelected}
					onClip={editor.clipSelected}
					onToggleAI={() => (ai.isActive ? ai.disable() : ai.enable())}
					onFindTrees={() => void ai.findConcept("tree")}
					onDeleteSelected={editor.deleteSelected}
					onUndo={editor.undo}
					canUndo={editor.canUndo}
					onSave={editing.handleSaveEdits}
					onCancel={editing.handleCancelEditing}
					position="top-right"
					title={`Editing ${editingLayerType === "deadwood" ? "deadwood cover" : "tree cover"}`}
				/>
			)}

			<DatasetAuditMap
				ref={mapRef}
				data={dataset}
				onMapReady={handleMapReady}
				onOrthoLayerReady={handleOrthoLayerReady}
				isEditing={isEditing}
				editingLayerType={editingLayerType}
				enableAOIEditing={false}
				canReviewCorrections={!isEditing}
				onApproveCorrection={(correctionId) => void review("approve")(correctionId)}
				onRevertCorrection={(correctionId) => void review("revert")(correctionId)}
				onEditDeadwood={startDeadwoodEdit}
				onEditForestCover={startForestCoverEdit}
				refreshKey={refreshKey}
			/>
		</div>
	);
}
