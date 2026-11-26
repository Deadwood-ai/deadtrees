import { Button, Tooltip } from "antd";
import { RightOutlined, SaveOutlined } from "@ant-design/icons";

interface AuditFooterProps {
	/** the next dataset that needs review; null when no other one does */
	nextDatasetId: number | null;
	isSaving: boolean;
	/** AOI edits not saved yet, or being saved: Save waits for them */
	isAOIBusy: boolean;
	onCancel: () => void;
	onSave: () => void;
	onSaveAndNext: () => void;
}

/** Cancel, Save (stores your answers as reviews, then back to the list) and Save & Next (on
 * to the next dataset that needs review). */
export default function AuditFooter({ nextDatasetId, isSaving, isAOIBusy, onCancel, onSave, onSaveAndNext }: AuditFooterProps) {
	const nextTip = nextDatasetId !== null ? `Save and go to the next dataset that needs review (#${nextDatasetId})` : "No other dataset needs review";
	return (
		<div className="flex items-center justify-end gap-2" data-testid="audit-footer">
			<Button onClick={onCancel}>Cancel</Button>
			<Tooltip title={isAOIBusy ? "Save the AOI edits first" : "Store your answers"}>
				<Button onClick={onSave} loading={isSaving} icon={<SaveOutlined />} disabled={isAOIBusy}>
					Save
				</Button>
			</Tooltip>
			<Tooltip title={nextTip}>
				<Button type="primary" onClick={onSaveAndNext} loading={isSaving} icon={<RightOutlined />} disabled={isAOIBusy || nextDatasetId === null}>
					Save & Next
				</Button>
			</Tooltip>
		</div>
	);
}
