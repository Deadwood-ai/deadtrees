import { useState } from "react";
import { Button, Card, Form, Radio, Space, Typography } from "antd";
import { AimOutlined } from "@ant-design/icons";
import { createConditionalRule } from "./auditConstants";
import { SuggestedTag } from "./AcquisitionDateCard";
import { ReviewChange, ReviewTag } from "./AuditReviewNotice";
import GeorefMatchViewer from "./GeorefMatchViewer";
import { summarizeGeorefCheck } from "../../utils/georefCheck";
import type { IAuditReviewItem, IAuditSuggestion } from "../../types/acquisitionDate";
import type { IGeorefCheck } from "../../types/georefCheck";

const { Text } = Typography;

interface GeoreferencingCardProps {
	check: IGeorefCheck | null | undefined;
	cogPath: string | null | undefined;
	suggestions: IAuditSuggestion[];
	/** fields the form filled from a suggestion (not from a saved audit) */
	prefilledFields: string[];
	reviewItems: IAuditReviewItem[];
	saved: Record<string, unknown> | null | undefined;
}

const TONE_BOX = {
	success: "border-green-200 bg-green-50",
	error: "border-red-200 bg-red-50",
	warning: "border-amber-200 bg-amber-50",
} as const;

// === Georeferencing Card (Step 1) ===
export function GeoreferencingCard({ check, cogPath, suggestions, prefilledFields, reviewItems, saved }: GeoreferencingCardProps) {
	const [viewerOpen, setViewerOpen] = useState(false);
	const summary = check ? summarizeGeorefCheck(check) : null;
	const underReview = reviewItems.some((i) => i.item === "is_georeferenced");
	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center">
				<Text strong className="text-xs">1. Georeferencing Accuracy</Text>
				{underReview ? (
					<ReviewTag item="is_georeferenced" items={reviewItems} />
				) : (
					<SuggestedTag field="is_georeferenced" suggestions={suggestions} prefilledFields={prefilledFields} />
				)}
			</div>
			<ReviewChange field="is_georeferenced" items={reviewItems} suggestions={suggestions} saved={saved} />
			{check && summary ? (
				<div className={`mb-2 rounded border px-2 py-1 ${TONE_BOX[summary.tone]}`}>
					<div className="flex items-center justify-between gap-2 text-xs">
						<span>
							<Text type="secondary">Automatic check: </Text>
							<Text strong>{summary.verdict}</Text>
						</span>
						{cogPath && (
							<Button size="small" type="link" className="p-0 text-xs" icon={<AimOutlined />} onClick={() => setViewerOpen(true)}>
								Show matching
							</Button>
						)}
					</div>
					<div className="text-[11px] text-gray-600">{summary.detail}</div>
				</div>
			) : (
				<div className="mb-2 text-xs text-gray-500">No automatic check yet (processing stage georef_check_v1).</div>
			)}
			<Form.Item name="is_georeferenced" className="mb-0" rules={createConditionalRule("Please assess georeferencing")}>
				<Radio.Group>
					<Space size="large">
						<Radio value={true}>🟢 Good (&lt;15m)</Radio>
						<Radio value={false}>🔴 Poor (&gt;15m)</Radio>
					</Space>
				</Radio.Group>
			</Form.Item>
			{check && cogPath && <GeorefMatchViewer open={viewerOpen} onClose={() => setViewerOpen(false)} check={check} cogPath={cogPath} />}
		</Card>
	);
}
