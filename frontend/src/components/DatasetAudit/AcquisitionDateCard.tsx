import { Alert, Card, Form, Input, Radio, Space, Tag, Tooltip, Typography } from "antd";
import { RobotOutlined } from "@ant-design/icons";
import { createConditionalRule, formatAcquisitionDate } from "./auditConstants";
import type { IDataset } from "../../types/dataset";
import type { IAcquisitionDateDecision, IAcquisitionDateEstimate, IAuditSuggestion } from "../../types/acquisitionDate";
import {
	activeDecision,
	datasetDateSuggestion,
	describeDeactivation,
	describeModelType,
	formatDateParts,
	formatIsoDate,
	isEstimateCurrent,
	joinYearWrap,
	modelSuggestedDecision,
} from "../../utils/acquisitionDate";
import AcquisitionDateDistribution from "../AcquisitionDate/AcquisitionDateDistribution";

const { Text } = Typography;
const { TextArea } = Input;

interface AcquisitionDateCardProps {
	dataset: IDataset;
	estimate: IAcquisitionDateEstimate | null | undefined;
	suggestions: IAuditSuggestion[];
	/** fields the form filled from a suggestion (not from a saved audit) */
	prefilledFields: string[];
	/** the dataset's date decisions, newest first */
	decisions: IAcquisitionDateDecision[];
}

const SOURCE_LABEL: Record<IAcquisitionDateDecision["source"], string> = {
	auditor: "by an auditor",
	automatic: "automatically by the date model",
	legacy_audit: "in an audit before the date model",
};

/** "Suggested" tag while a prefilled field still holds the machine value. */
function SuggestedTag({ field, suggestions, prefilledFields }: { field: string; suggestions: IAuditSuggestion[]; prefilledFields: string[] }) {
	const form = Form.useFormInstance();
	// preserve: read the store even before the field's Form.Item registers
	const value = Form.useWatch(field, { form, preserve: true });
	const suggestion = suggestions.find((s) => s.field === field);
	if (!suggestion || !prefilledFields.includes(field) || value !== suggestion.value) return null;
	return (
		<Tooltip title={`Prefilled by ${suggestion.source}; saving the audit records it as your decision`}>
			<Tag icon={<RobotOutlined />} color="blue" className="ml-2 text-[10px]">
				suggested
			</Tag>
		</Tooltip>
	);
}

function isoDate(y: number | string | null, m: number | string | null, d: number | string | null): string | null {
	if (!y || !m || !d) return null;
	const pad = (v: number | string) => String(v).padStart(2, "0");
	return `${y}-${pad(m)}-${pad(d)}`;
}

function recordedIsoDate(dataset: IDataset): string | null {
	return isoDate(dataset.aquisition_year, dataset.aquisition_month ?? null, dataset.aquisition_day ?? null);
}

/** The date check's state: the active decision, or why the last one was reopened. */
function DecisionStatus({ decisions }: { decisions: IAcquisitionDateDecision[] }) {
	const active = activeDecision(decisions);
	const when = (iso: string) => formatIsoDate(iso.slice(0, 10));
	const verdictOf = (d: IAcquisitionDateDecision) =>
		d.suggestion_decision === "accepted" ? "suggested date accepted" : d.date_valid ? "reported date valid" : "reported date invalid";
	if (active) {
		const verdict = verdictOf(active);
		return (
			<div className="mb-2 text-[11px] text-gray-500">
				Decided {SOURCE_LABEL[active.source]} on {when(active.decided_at)}: {verdict}
				{active.estimate_model_version ? ` (${active.estimate_model_version})` : ""}.
			</div>
		);
	}
	const last = decisions[0];
	if (!last?.superseded_at) return null;
	return (
		<Alert
			type="info"
			showIcon
			className="mb-2 py-1 text-xs"
			message={`The date check from ${when(last.decided_at)} (${verdictOf(last)}) was reopened on ${when(last.superseded_at)}: ${describeDeactivation(last)}. The saved verdict stays in place until you save; the form shows the current suggestion.`}
		/>
	);
}

export function AcquisitionDateCard({ dataset, estimate, suggestions, prefilledFields, decisions }: AcquisitionDateCardProps) {
	const current = estimate ? isEstimateCurrent(estimate, dataset) : false;
	const suggestion = datasetDateSuggestion(estimate, dataset);
	const applied = modelSuggestedDecision(decisions, dataset);
	const ranges = joinYearWrap(estimate?.hdi["80"] ?? [])
		.map(([s, e]) => `${formatIsoDate(s, { day: "numeric", month: "short" })} – ${formatIsoDate(e, { day: "numeric", month: "short" })}`)
		.join(", ");

	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center">
				<Text strong className="text-xs">2. Acquisition Date</Text>
			</div>
			<div className="mb-1 text-xs">
				<Text type="secondary">{applied ? "Date: " : "Reported date: "}</Text>
				<Text strong>{formatAcquisitionDate(dataset)}</Text>
				{applied && (
					<Tag color="gold" className="ml-2 text-[10px]">
						model-suggested
					</Tag>
				)}
			</div>
			{applied && (
				<div className="mb-1 text-[11px] text-gray-500">
					Reported was {formatDateParts(applied.reported_year, applied.reported_month, applied.reported_day)}.
				</div>
			)}
			<DecisionStatus decisions={decisions} />

			{estimate ? (
				<>
					<div className="mb-1 flex items-center justify-between text-xs">
						<Text type="secondary">
							Model estimate: <Text strong>{formatIsoDate(estimate.predicted_date)}</Text>
						</Text>
						<Tooltip title={`${estimate.model_version} · ${describeModelType(estimate)}`}>
							<Tag className="m-0 text-[10px]" color={estimate.model_type === "s2" ? "geekblue" : "default"}>
								{estimate.model_type === "s2" ? "with Sentinel-2" : "no Sentinel-2"}
							</Tag>
						</Tooltip>
					</div>
					<AcquisitionDateDistribution
						estimate={estimate}
						// after an accepted suggestion, mark the reported date it replaced
						recordedDate={applied ? isoDate(applied.reported_year, applied.reported_month, applied.reported_day) : recordedIsoDate(dataset)}
					/>
					<div className="mb-2 text-[11px] text-gray-500">
						80% likely: {ranges} ({estimate.hdi80_days} days)
						{estimate.n_modes > 1 && " · several plausible seasons, so distant dates are not flagged"}
					</div>
				</>
			) : (
				<div className="mb-2 text-xs text-gray-500">No date estimate yet (processing stage doy_estimation_v1).</div>
			)}

			{estimate && current && estimate.is_mismatch && (
				<Alert
					type="warning"
					showIcon
					className="mb-2 py-1 text-xs"
					message={`Reported date is ${Math.round(estimate.recorded_offset_days ?? 0)} days from the estimate and outside the model's 99% range.`}
				/>
			)}

			<div className="flex items-center text-xs">
				<Text type="secondary">Reported date valid?</Text>
				<SuggestedTag field="has_valid_acquisition_date" suggestions={suggestions} prefilledFields={prefilledFields} />
			</div>
			<Form.Item name="has_valid_acquisition_date" className="mb-2" rules={createConditionalRule("Please validate acquisition date")}>
				<Radio.Group>
					<Space size="large">
						<Radio value={true}>🟢 Valid</Radio>
						<Radio value={false}>🔴 Invalid</Radio>
					</Space>
				</Radio.Group>
			</Form.Item>

			{(suggestion || applied) && (
				<div className="mb-2 rounded border border-blue-100 bg-blue-50 px-2 py-1">
					<div className="flex items-center text-xs">
						<Text>
							Suggested date: <Text strong>{formatIsoDate((suggestion?.date ?? applied?.suggested_date) as string)}</Text>
							{suggestion && (
								<Text type="secondary">
									{" "}
									({suggestion.reason === "missing_month" ? "reported date has no month" : "large mismatch"}
									{estimate?.recommend_accept ? ", model recommends accepting" : ", estimate too uncertain to recommend"})
								</Text>
							)}
						</Text>
						<SuggestedTag field="accept_suggested_acquisition_date" suggestions={suggestions} prefilledFields={prefilledFields} />
					</div>
					<Form.Item name="accept_suggested_acquisition_date" className="mb-0">
						<Radio.Group>
							<Space size="large">
								<Radio value={true}>Use suggested date</Radio>
								<Radio value={false}>Keep reported date</Radio>
							</Space>
						</Radio.Group>
					</Form.Item>
				</div>
			)}

			<Form.Item name="acquisition_date_notes" className="mb-0">
				<TextArea rows={2} placeholder="Date notes..." className="text-xs" />
			</Form.Item>
		</Card>
	);
}
