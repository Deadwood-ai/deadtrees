import { Form, Radio, Space, Typography } from "antd";
import { createConditionalRule } from "./auditConstants";
import { SuggestedTag } from "./AcquisitionDateCard";
import { ReviewChange, ReviewTag } from "./AuditReviewNotice";
import { summarizeGeorefCheck } from "../../utils/georefCheck";
import type { IAuditReviewItem, IAuditSuggestion } from "../../types/acquisitionDate";
import type { IGeorefCheck } from "../../types/georefCheck";

const { Text } = Typography;

interface GeoreferencingCardProps {
	check: IGeorefCheck | null | undefined;
	suggestions: IAuditSuggestion[];
	/** fields the form filled from a suggestion (not from a saved audit) */
	prefilledFields: string[];
	reviewItems: IAuditReviewItem[];
	saved: Record<string, unknown> | null | undefined;
	/** the check has run: the reviewer's answer above decides this field */
	answerOwned?: boolean;
}

const TONE_BOX = {
	success: "border-green-200 bg-green-50",
	error: "border-red-200 bg-red-50",
	warning: "border-amber-200 bg-amber-50",
} as const;

/** The georeferencing check's call and the saved answer; the map shows the matching while the section is open. */
export function GeoreferencingCard({ check, suggestions, prefilledFields, reviewItems, saved, answerOwned }: GeoreferencingCardProps) {
	const summary = check ? summarizeGeorefCheck(check) : null;
	const underReview = reviewItems.some((i) => i.item === "is_georeferenced");
	return (
		<div>
			<ReviewChange field="is_georeferenced" items={reviewItems} suggestions={suggestions} saved={saved} />
			{check && summary ? (
				<div className={`mb-2 rounded border px-2 py-1 ${TONE_BOX[summary.tone]}`}>
					<div className="flex items-center justify-between gap-2 text-xs">
						<span>
							<Text type="secondary">Automatic check: </Text>
							<Text strong>{summary.verdict}</Text>
						</span>
					</div>
					<div className="text-[11px] text-gray-600">{summary.detail}</div>
				</div>
			) : (
				<div className="mb-2 text-xs text-gray-500">No automatic check yet (processing stage georef_check_v1).</div>
			)}
			<div className="flex items-center text-xs">
				<Text type="secondary">{answerOwned ? "Saved audit (follows your answer above)" : "Saved audit"}</Text>
				{underReview ? (
					<ReviewTag item="is_georeferenced" items={reviewItems} />
				) : (
					<SuggestedTag field="is_georeferenced" suggestions={suggestions} prefilledFields={prefilledFields} />
				)}
			</div>
			<Form.Item name="is_georeferenced" className="mb-0" rules={createConditionalRule("Please assess georeferencing")}>
				<Radio.Group disabled={answerOwned || undefined}>
					<Space size="large">
						<Radio value={true}>🟢 Good (&lt;15m)</Radio>
						<Radio value={false}>🔴 Poor (&gt;15m)</Radio>
					</Space>
				</Radio.Group>
			</Form.Item>
		</div>
	);
}
