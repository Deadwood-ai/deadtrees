import { Button, Tooltip, Tag, Form } from "antd";
import { SaveOutlined, CheckCircleOutlined, RightOutlined } from "@ant-design/icons";

interface AuditFooterProps {
	// Form state
	hasAOI: boolean;
	getFieldValue: (name: string) => unknown;

	// Audit context
	isPending: boolean;
	isReviewed: boolean;
	reviewedByEmail?: string | null;

	// Navigation
	nextDatasetId: number | null;
	currentDatasetIndex: number;
	totalCount: number;

	// Loading states
	isSaving: boolean;
	navigateToNext: boolean;
	isMarkingReviewed: boolean;

	// Handlers
	onCancel: () => void;
	onSave: () => void;
	onSaveAndNext: () => void;
	onMarkReviewedAndNext: () => void;
}

export default function AuditFooter({
	hasAOI,
	getFieldValue,
	isPending,
	isReviewed,
	reviewedByEmail,
	nextDatasetId,
	currentDatasetIndex,
	totalCount,
	isSaving,
	navigateToNext,
	isMarkingReviewed,
	onCancel,
	onSave,
	onSaveAndNext,
	onMarkReviewedAndNext,
}: AuditFooterProps) {
	const assessment = getFieldValue("final_assessment");
	const aoiRequired = assessment === "no_issues";
	const isDisabled = aoiRequired && !hasAOI;
	const hasNext = nextDatasetId !== null;
	const idx = currentDatasetIndex;

	// Build position indicator - show current position in filtered list
	const positionText = idx >= 0 && totalCount > 0 ? `${idx + 1} of ${totalCount}` : "";

	// Tooltip text for Save & Next
	const saveNextTooltip = hasNext
		? `Save and go to dataset #${nextDatasetId} (${positionText} in current filter)`
		: idx >= 0
			? `Last dataset in filter (${positionText})`
			: "No datasets in filter";

	// Tooltip text for Review & Next
	const reviewNextTooltip = hasNext
		? `Mark reviewed and go to #${nextDatasetId} (${positionText} in current filter)`
		: "Mark reviewed and return to list";

	return (
		<div className="flex items-center justify-between gap-2">
			{/* Left: Review status indicator (completed only) */}
			<div>
				{isReviewed && reviewedByEmail && (
					<Tag color="blue" className="text-xs">
						✓ Reviewed by {reviewedByEmail.split("@")[0]}
					</Tag>
				)}
			</div>

			{/* Right: Action buttons */}
			<div className="flex items-center gap-2">
				<Button onClick={onCancel}>Cancel</Button>
				<Button
					type={isPending ? "primary" : "default"}
					onClick={onSave}
					loading={isSaving && !navigateToNext}
					icon={<SaveOutlined />}
					disabled={isDisabled}
				>
					Save
				</Button>

				{/* Pending: Save & Next for audit workflow */}
				{isPending && totalCount > 0 && (
					<Tooltip title={saveNextTooltip}>
						<Button
							type="primary"
							onClick={onSaveAndNext}
							loading={isSaving && navigateToNext}
							icon={<RightOutlined />}
							disabled={isDisabled || !hasNext}
						>
							Save & Next
						</Button>
					</Tooltip>
				)}

				{/* Completed (not reviewed): Mark Reviewed & Next for review workflow */}
				{!isPending && !isReviewed && (
					<Tooltip title={reviewNextTooltip}>
						<Button
							type="primary"
							onClick={onMarkReviewedAndNext}
							loading={isMarkingReviewed}
							icon={<CheckCircleOutlined />}
						>
							{hasNext ? "Review & Next" : "Mark Reviewed"}
						</Button>
					</Tooltip>
				)}
			</div>
		</div>
	);
}

// Wrapper component that uses Form.Item to get field values
interface AuditFooterWrapperProps extends Omit<AuditFooterProps, "getFieldValue"> { }

export function AuditFooterFormItem(props: AuditFooterWrapperProps) {
	return (
		<Form.Item
			shouldUpdate={(prevValues, currentValues) => prevValues.final_assessment !== currentValues.final_assessment}
			className="mb-0"
		>
			{({ getFieldValue }) => <AuditFooter {...props} getFieldValue={getFieldValue} />}
		</Form.Item>
	);
}
