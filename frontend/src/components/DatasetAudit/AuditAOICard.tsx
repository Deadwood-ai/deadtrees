import {
	CloseOutlined,
	DeleteOutlined,
	EditOutlined,
	MergeCellsOutlined,
	PlusOutlined,
	SaveOutlined,
	ScissorOutlined,
	UndoOutlined,
} from "@ant-design/icons";
import { Button, Card, Form, Typography } from "antd";

import type { AOIToolbarState } from "../DatasetDetailsMap/hooks/useAOIEditor";
import type { AuditMapWithControlsHandle } from "./AuditMapWithControls";

const { Text } = Typography;

interface AuditAOICardProps {
	aoiToolbarState: AOIToolbarState;
	mapRef: React.RefObject<AuditMapWithControlsHandle>;
	isDirty: boolean;
	isSaving: boolean;
	onSaveAOI: () => void;
}

export default function AuditAOICard({
	aoiToolbarState,
	mapRef,
	isDirty,
	isSaving,
	onSaveAOI,
}: AuditAOICardProps) {
	const isIdle = !aoiToolbarState.isDrawing && !aoiToolbarState.isEditing;

	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center">
				<Text strong className="text-xs">7. Area of Interest (AOI)</Text>
			</div>

			{aoiToolbarState.isAOILoading ? (
				<div className="text-xs text-gray-500">Loading AOI...</div>
			) : (
				<div className="space-y-2">
					{isIdle && aoiToolbarState.hasAOI && (
						<div className="rounded bg-green-50 px-2 py-1 text-xs text-green-700">
							AOI defined ({aoiToolbarState.polygonCount} polygon{aoiToolbarState.polygonCount !== 1 ? "s" : ""})
						</div>
					)}

					{isDirty && (
						<div className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
							{aoiToolbarState.hasAOI
								? "Unsaved AOI edits"
								: "AOI draft cleared. Draw a replacement AOI to save."}
						</div>
					)}

					{isIdle && !aoiToolbarState.hasAOI && (
						<Button
							icon={<PlusOutlined />}
							onClick={() => mapRef.current?.startDrawing()}
							size="small"
						>
							Draw AOI Polygon
						</Button>
					)}

					{aoiToolbarState.isDrawing && (
						<Button
							icon={<CloseOutlined />}
							onClick={() => mapRef.current?.cancelDrawing()}
							size="small"
						>
							{aoiToolbarState.drawingMode === "cut" ? "Cancel Cut" : "Cancel Drawing"}
						</Button>
					)}

					{isIdle && aoiToolbarState.hasAOI && (
						<div className="flex flex-wrap gap-2">
							<Button
								icon={<EditOutlined />}
								onClick={() => mapRef.current?.startEditing()}
								size="small"
							>
								Edit
							</Button>
							<Button
								icon={<PlusOutlined />}
								onClick={() => mapRef.current?.addAnotherPolygon()}
								size="small"
							>
								Add
							</Button>
							<Button
								icon={<DeleteOutlined />}
								onClick={() => mapRef.current?.deleteAOI()}
								size="small"
								danger
							>
								Clear Draft
							</Button>
						</div>
					)}

					{aoiToolbarState.isEditing && !aoiToolbarState.isDrawing && (
						<div className="flex flex-wrap gap-2">
							<Button
								icon={<SaveOutlined />}
								onClick={() => mapRef.current?.saveEditing()}
								size="small"
								type="primary"
							>
								Apply
							</Button>
							<Button
								icon={<CloseOutlined />}
								onClick={() => mapRef.current?.cancelEditing()}
								size="small"
							>
								Cancel
							</Button>
							<Button
								icon={<ScissorOutlined />}
								onClick={() => mapRef.current?.cutSelectedPolygon()}
								size="small"
								disabled={aoiToolbarState.selectionCount !== 1}
								title="Cut from the selected polygon"
							>
								Cut
							</Button>
							<Button
								icon={<MergeCellsOutlined />}
								onClick={() => mapRef.current?.mergeSelectedPolygons()}
								size="small"
								disabled={aoiToolbarState.selectionCount !== 2}
								title="Merge two selected polygons"
							>
								Merge
							</Button>
							<Button
								icon={<ScissorOutlined rotate={90} />}
								onClick={() => mapRef.current?.clipSelectedPolygons()}
								size="small"
								disabled={aoiToolbarState.selectionCount !== 2}
								title="Clip the smaller polygon from the larger"
							>
								Clip
							</Button>
							<Button
								icon={<DeleteOutlined />}
								onClick={() => mapRef.current?.deleteSelectedPolygon()}
								size="small"
								danger
								disabled={aoiToolbarState.selectionCount === 0}
							>
								Delete
							</Button>
							<Button
								icon={<UndoOutlined />}
								onClick={() => mapRef.current?.undoAOIChange()}
								size="small"
								disabled={!aoiToolbarState.canUndo}
							>
								Undo
							</Button>
						</div>
					)}

					{isIdle && aoiToolbarState.canUndo && (
						<Button
							icon={<UndoOutlined />}
							onClick={() => mapRef.current?.undoAOIChange()}
							size="small"
						>
							Undo AOI Change
						</Button>
					)}

					{isIdle && aoiToolbarState.hasAOI && isDirty && (
						<Button
							icon={<SaveOutlined />}
							onClick={onSaveAOI}
							size="small"
							type="primary"
							loading={isSaving}
						>
							Save AOI
						</Button>
					)}
				</div>
			)}

			<Form.Item
				shouldUpdate={(previousValues, currentValues) =>
					previousValues.final_assessment !== currentValues.final_assessment
				}
				className="mb-0 mt-2"
			>
				{({ getFieldValue }) => {
					const assessment = getFieldValue("final_assessment");
					if (aoiToolbarState.hasAOI) return null;

					return (
						<div className={`text-xs ${assessment === "no_issues" ? "text-orange-600" : "text-gray-500"}`}>
							{assessment === "no_issues"
								? "AOI required for \"Ready\" assessment"
								: "AOI optional for this assessment"}
						</div>
					);
				}}
			</Form.Item>
		</Card>
	);
}
