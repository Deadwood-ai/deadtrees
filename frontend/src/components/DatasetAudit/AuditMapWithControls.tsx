import { useRef, forwardRef, useImperativeHandle, useEffect, useCallback } from "react";
import { message, Tag, Tooltip } from "antd";
import { EditOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { useQueryClient } from "@tanstack/react-query";
import type { Map as OLMap } from "ol";
import type TileLayerWebGL from "ol/layer/WebGLTile.js";

import { IDataset } from "../../types/dataset";
import DatasetAuditMap, { DatasetAuditMapHandle } from "./DatasetAuditMap";
import { AOIToolbarState } from "../DatasetDetailsMap/hooks/useAOIEditor";
import DatasetLayerControlPanel from "../DatasetDetailsMap/DatasetLayerControlPanel";
import EditorToolbar from "../PolygonEditor/EditorToolbar";
import { useDatasetDetailsMap } from "../../hooks/useDatasetDetailsMapProvider";
import { useDatasetLabelTypes } from "../../hooks/useDatasetLabelTypes";
import { useApproveCorrection, useRevertCorrection } from "../../hooks/useSaveCorrections";
import { useCorrectionStats, useCorrectionContributors, usePendingCorrectionLocations } from "../../hooks/usePendingCorrections";
import { useAuth } from "../../hooks/useAuthProvider";
import { useDatasetEditing } from "../../hooks/useDatasetEditing";
import { mapColors } from "../../theme/mapColors";
import { MAP_FLOATING_TOP_CLASS } from "../../theme/mapLayout";

interface AuditMapWithControlsProps {
	dataset: IDataset;
	onAOIChange: (geometry: GeoJSON.MultiPolygon | GeoJSON.Polygon | null) => void;
	onToolbarStateChange: (state: AOIToolbarState) => void;
	onEditingStateChange?: (isEditing: boolean, layerType: "deadwood" | "forest_cover" | null) => void;
}

export interface AuditMapWithControlsHandle {
	// Map utilities
	refreshVectorLayers: () => void;
	zoomToExtent: (minLon: number, minLat: number, maxLon: number, maxLat: number, padding?: number) => void;
	flashLocation: (lon: number, lat: number) => void;

	// AOI editing methods
	startDrawing: () => void;
	cancelDrawing: () => void;
	startEditing: () => void;
	saveEditing: () => void;
	cancelEditing: () => void;
	addAnotherPolygon: () => void;
	deleteAOI: () => void;
	deleteSelectedPolygon: () => void;
}

/**
 * Map component with controls for the audit detail view
 * Uses the dedicated DatasetAuditMap component
 */
const AuditMapWithControls = forwardRef<AuditMapWithControlsHandle, AuditMapWithControlsProps>(
	({ dataset, onAOIChange, onToolbarStateChange, onEditingStateChange }, ref) => {
		// Map ref - use the DatasetAuditMapHandle type
		const mapRef = useRef<DatasetAuditMapHandle>(null);

		// Get current user for editing
		const { user } = useAuth();

		// Get layer control state from context
		const {
			layerControl,
			setMapStyle,
			setShowForestCover,
			setShowDeadwood,
			setShowDroneImagery,
			setShowAOI,
			setLayerOpacity,
		} = useDatasetDetailsMap();

		// Check if labels exist
		const { deadwood, forestCover } = useDatasetLabelTypes({
			datasetId: dataset?.id,
			enabled: !!dataset?.id,
		});

		const hasDeadwood = !!deadwood.data?.id;
		const hasForestCover = !!forestCover.data?.id && !!dataset.is_forest_cover_done;

		// Editing hook for polygon corrections
		const editing = useDatasetEditing({ datasetId: dataset?.id, user });
		const { isEditing, editingLayerType, editor, ai, refreshKey } = editing;

		// Notify parent of editing state changes
		useEffect(() => {
			onEditingStateChange?.(isEditing, editingLayerType);
		}, [isEditing, editingLayerType, onEditingStateChange]);

		// Correction approval/revert mutations
		const queryClient = useQueryClient();
		const { mutateAsync: approveCorrection } = useApproveCorrection();
		const { mutateAsync: revertCorrection } = useRevertCorrection();

		// Expose methods to parent - delegate to mapRef
		useImperativeHandle(ref, () => ({
			// Map utilities
			refreshVectorLayers: () => mapRef.current?.refreshVectorLayers(),
			zoomToExtent: (minLon: number, minLat: number, maxLon: number, maxLat: number, padding?: number) =>
				mapRef.current?.zoomToExtent(minLon, minLat, maxLon, maxLat, padding),
			flashLocation: (lon: number, lat: number) => mapRef.current?.flashLocation(lon, lat),

			// AOI editing methods
			startDrawing: () => mapRef.current?.startDrawing(),
			cancelDrawing: () => mapRef.current?.cancelDrawing(),
			startEditing: () => mapRef.current?.startEditing(),
			saveEditing: () => mapRef.current?.saveEditing(),
			cancelEditing: () => mapRef.current?.cancelEditing(),
			addAnotherPolygon: () => mapRef.current?.addAnotherPolygon(),
			deleteAOI: () => mapRef.current?.deleteAOI(),
			deleteSelectedPolygon: () => mapRef.current?.deleteSelectedPolygon(),
		}), []);

		// Handlers for correction review
		const handleApproveCorrection = async (correctionId: number, _geometryId: number) => {
			try {
				const result = await approveCorrection(correctionId);
				if (result) {
					message.success("Correction approved");
					queryClient.invalidateQueries({ queryKey: ["pendingCorrections"] });
					queryClient.invalidateQueries({ queryKey: ["correctionStats", dataset?.id] });
					queryClient.invalidateQueries({ queryKey: ["correctionContributors", dataset?.id] });
					queryClient.invalidateQueries({ queryKey: ["pendingCorrectionLocations", dataset?.id] });
					mapRef.current?.refreshVectorLayers();
				} else {
					message.error("Failed to approve correction");
				}
			} catch (error) {
				console.error("Error approving correction:", error);
				message.error("Failed to approve correction");
			}
		};

		const handleRevertCorrection = async (correctionId: number, _geometryId: number) => {
			try {
				const result = await revertCorrection(correctionId);
				if (result) {
					message.success("Correction reverted");
					queryClient.invalidateQueries({ queryKey: ["pendingCorrections"] });
					queryClient.invalidateQueries({ queryKey: ["correctionStats", dataset?.id] });
					queryClient.invalidateQueries({ queryKey: ["correctionContributors", dataset?.id] });
					queryClient.invalidateQueries({ queryKey: ["pendingCorrectionLocations", dataset?.id] });
					mapRef.current?.refreshVectorLayers();
				} else {
					message.error("Failed to revert correction");
				}
			} catch (error) {
				console.error("Error reverting correction:", error);
				message.error("Failed to revert correction");
			}
		};

		// Correction stats
		const { data: correctionStats } = useCorrectionStats(dataset?.id);
		const { data: contributors } = useCorrectionContributors(dataset?.id);
		const { data: pendingLocations } = usePendingCorrectionLocations(dataset?.id);

		const pendingDeadwood = pendingLocations?.filter(p => p.layerType === "deadwood").length ?? 0;
		const pendingForestCover = pendingLocations?.filter(p => p.layerType === "forest_cover").length ?? 0;

		// Flash pending corrections
		const handleFlashPending = (layerType?: "deadwood" | "forest_cover") => {
			if (!pendingLocations || pendingLocations.length === 0) return;

			const filtered = layerType
				? pendingLocations.filter(p => p.layerType === layerType)
				: pendingLocations;

			if (filtered.length === 0) return;

			const minLon = Math.min(...filtered.map(p => p.minLon));
			const minLat = Math.min(...filtered.map(p => p.minLat));
			const maxLon = Math.max(...filtered.map(p => p.maxLon));
			const maxLat = Math.max(...filtered.map(p => p.maxLat));

			mapRef.current?.zoomToExtent(minLon, minLat, maxLon, maxLat, 50);

			filtered.forEach((loc, index) => {
				setTimeout(() => {
					mapRef.current?.flashLocation(loc.centroidLon, loc.centroidLat);
				}, index * 200);
			});
		};

		// Map ready callback - pass to editing hook
		const handleMapReady = useCallback((map: OLMap) => {
			editing.handleMapReady(map);
		}, [editing]);

		// Ortho layer ready callback - pass to editing hook
		const handleOrthoLayerReady = useCallback((layer: TileLayerWebGL) => {
			editing.handleOrthoLayerReady(layer);
		}, [editing]);

		return (
			<div className="relative h-full w-full flex-1">
				{/* Correction Stats Indicator */}
				{!isEditing && correctionStats && correctionStats.total > 0 && (
					<div className="absolute left-3 top-3 z-50 pointer-events-auto md:left-[calc(420px+2rem)] md:top-24">
						<div className="flex flex-col gap-1.5 rounded-lg bg-white/95 p-2.5 shadow-lg backdrop-blur-sm">
							<div className="text-xs font-medium text-gray-600 mb-1">Edit Review Progress</div>
							{correctionStats.pending > 0 ? (
								<>
									<Tooltip title="Click to zoom and flash all pending edits">
										<Tag
											icon={<EditOutlined />}
											color="orange"
											className="m-0 cursor-pointer hover:opacity-80"
											onClick={() => handleFlashPending()}
										>
											{correctionStats.pending} pending
										</Tag>
									</Tooltip>
									<div className="flex flex-col gap-1 ml-2">
										{pendingDeadwood > 0 && (
											<Tooltip title="Click to show pending deadwood edits">
												<div
													className="flex items-center gap-1.5 text-[10px] text-gray-600 cursor-pointer hover:text-orange-600"
													onClick={() => handleFlashPending("deadwood")}
												>
													<span className="h-2 w-2 rounded-sm" style={{ backgroundColor: mapColors.deadwood.fill }} />
													<span>{pendingDeadwood} deadwood</span>
												</div>
											</Tooltip>
										)}
										{pendingForestCover > 0 && (
											<Tooltip title="Click to show pending forest cover edits">
												<div
													className="flex items-center gap-1.5 text-[10px] text-gray-600 cursor-pointer hover:text-green-600"
													onClick={() => handleFlashPending("forest_cover")}
												>
													<span className="h-2 w-2 rounded-sm bg-green-500" />
													<span>{pendingForestCover} forest cover</span>
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
								<Tooltip title={`${correctionStats.approved} edits approved`}>
									<Tag color="green" className="m-0">
										{correctionStats.approved} approved
									</Tag>
								</Tooltip>
							)}
							{correctionStats.rejected > 0 && (
								<Tooltip title={`${correctionStats.rejected} edits reverted`}>
									<Tag color="default" className="m-0">
										{correctionStats.rejected} reverted
									</Tag>
								</Tooltip>
							)}
							{contributors && contributors.length > 0 && (
								<div className="border-t border-gray-200 mt-1.5 pt-1.5">
									<div className="text-[10px] text-gray-500 mb-1">Contributors:</div>
									{contributors.slice(0, 3).map((contributor, idx) => (
										<div key={idx} className="text-[10px] text-gray-600 truncate" title={contributor.email}>
											{contributor.email.split('@')[0]} ({contributor.count})
										</div>
									))}
									{contributors.length > 3 && (
										<div className="text-[10px] text-gray-400">
											+{contributors.length - 3} more
										</div>
									)}
								</div>
							)}
						</div>
					</div>
				)}

				{/* Layer Control Panel */}
				{!isEditing && (
					<div className={`absolute right-4 ${MAP_FLOATING_TOP_CLASS} z-50 pointer-events-auto`}>
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
							onReportClick={() => { }}
							onEditForestCover={hasForestCover ? () => editing.handleStartEditing("forest_cover") : undefined}
							onEditDeadwood={hasDeadwood ? () => editing.handleStartEditing("deadwood") : undefined}
							isLoggedIn={true}
						/>
					</div>
				)}

				{/* Editor Toolbar */}
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
						onDeleteSelected={editor.deleteSelected}
						onUndo={editor.undo}
						canUndo={editor.canUndo}
						onSave={editing.handleSaveEdits}
						onCancel={editing.handleCancelEditing}
						position="top-right"
						title={`Editing ${editingLayerType === "deadwood" ? "Deadwood" : "Forest Cover"}`}
					/>
				)}

				{/* Audit Map - dedicated component */}
				<DatasetAuditMap
					ref={mapRef}
					data={dataset}
					onMapReady={handleMapReady}
					onOrthoLayerReady={handleOrthoLayerReady}
					isEditing={isEditing}
					editingLayerType={editingLayerType}
					enableAOIEditing={!isEditing}
					onAOIChange={onAOIChange}
					onToolbarStateChange={onToolbarStateChange}
					canReviewCorrections={!isEditing}
					onApproveCorrection={handleApproveCorrection}
					onRevertCorrection={handleRevertCorrection}
					onEditDeadwood={hasDeadwood ? () => editing.handleStartEditing("deadwood") : undefined}
					onEditForestCover={hasForestCover ? () => editing.handleStartEditing("forest_cover") : undefined}
					refreshKey={refreshKey}
				/>
			</div>
		);
	}
);

AuditMapWithControls.displayName = "AuditMapWithControls";

export default AuditMapWithControls;
export type { AOIToolbarState };
