import { useState } from "react";
import { Alert, Button, Card, Form, Radio, Space, Typography } from "antd";
import { AimOutlined } from "@ant-design/icons";
import { createConditionalRule } from "./auditConstants";
import { SuggestedTag } from "./AcquisitionDateCard";
import GeorefMatchViewer from "./GeorefMatchViewer";
import { summarizeGeorefCheck } from "../../utils/georefCheck";
import type { IAuditSuggestion } from "../../types/acquisitionDate";
import type { IGeorefCheck } from "../../types/georefCheck";

const { Text } = Typography;

interface GeoreferencingCardProps {
	check: IGeorefCheck | null | undefined;
	cogPath: string | null | undefined;
	suggestions: IAuditSuggestion[];
	/** fields the form filled from a suggestion (not from a saved audit) */
	prefilledFields: string[];
}

// === Georeferencing Card (Step 1) ===
export function GeoreferencingCard({ check, cogPath, suggestions, prefilledFields }: GeoreferencingCardProps) {
	const [viewerOpen, setViewerOpen] = useState(false);
	const summary = check ? summarizeGeorefCheck(check) : null;
	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center">
				<Text strong className="text-xs">1. Georeferencing Accuracy</Text>
				<SuggestedTag field="is_georeferenced" suggestions={suggestions} prefilledFields={prefilledFields} />
			</div>
			{check && summary && (
				<Alert
					type={summary.tone}
					showIcon
					className="mb-2 text-xs"
					message={<span className="text-xs">{summary.text}</span>}
					action={
						cogPath ? (
							<Button size="small" icon={<AimOutlined />} onClick={() => setViewerOpen(true)}>
								Show matching
							</Button>
						) : undefined
					}
				/>
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
