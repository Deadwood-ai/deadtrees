import { Alert, Card, Form, Input, Radio, Space, Tag, Tooltip, Typography } from "antd";
import { RobotOutlined } from "@ant-design/icons";
import { createConditionalRule, formatAcquisitionDate } from "./auditConstants";
import type { IDataset } from "../../types/dataset";
import type { IAcquisitionDateEstimate, IAuditSuggestion } from "../../types/acquisitionDate";
import type { AuditFormValues } from "../../hooks/useDatasetAudit";

type SavedDateDecision = Pick<AuditFormValues, "accept_suggested_acquisition_date" | "original_acquisition_date" | "applied_acquisition_date">;
import { datasetDateSuggestion, describeModelType, formatIsoDate, isEstimateCurrent, joinYearWrap } from "../../utils/acquisitionDate";
import AcquisitionDateDistribution from "../AcquisitionDate/AcquisitionDateDistribution";

const { Text } = Typography;
const { TextArea } = Input;

interface AcquisitionDateCardProps {
	dataset: IDataset;
	estimate: IAcquisitionDateEstimate | null | undefined;
	suggestions: IAuditSuggestion[];
	/** fields the form filled from a suggestion (not from a saved audit) */
	prefilledFields: string[];
	auditData: SavedDateDecision | null | undefined;
}

/** "Suggested" tag while a prefilled field still holds the machine value. */
function SuggestedTag({ field, suggestions, prefilledFields }: { field: string; suggestions: IAuditSuggestion[]; prefilledFields: string[] }) {
	const form = Form.useFormInstance();
	// preserve: read the store even before the field's Form.Item registers
	const value = Form.useWatch(field, { form, preserve: true });
	const suggestion = suggestions.find((s) => s.field === field);
	if (!suggestion || !prefilledFields.includes(field) || value !== suggestion.value) return null;
	return (
		<Tooltip title={`Prefilled by ${suggestion.source}; saving the audit confirms it`}>
			<Tag icon={<RobotOutlined />} color="blue" className="ml-2 text-[10px]">
				suggested
			</Tag>
		</Tooltip>
	);
}

function recordedIsoDate(dataset: IDataset): string | null {
	if (!dataset.aquisition_year || !dataset.aquisition_month || !dataset.aquisition_day) return null;
	const pad = (v: number | string) => String(v).padStart(2, "0");
	return `${dataset.aquisition_year}-${pad(dataset.aquisition_month)}-${pad(dataset.aquisition_day)}`;
}

function EstimateSummary({ estimate, dataset }: { estimate: IAcquisitionDateEstimate; dataset: IDataset }) {
	const ranges = joinYearWrap(estimate.hdi["80"] ?? []).map(([s, e]) => `${formatIsoDate(s, { day: "numeric", month: "short" })} – ${formatIsoDate(e, { day: "numeric", month: "short" })}`);
	return (
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
			<AcquisitionDateDistribution estimate={estimate} recordedDate={recordedIsoDate(dataset)} />
			<div className="mb-2 text-[11px] text-gray-500">
				80% likely: {ranges.join(", ")} ({estimate.hdi80_days} days)
				{estimate.n_modes > 1 && " · several plausible seasons, so distant dates are not flagged"}
			</div>
		</>
	);
}

export function AcquisitionDateCard({ dataset, estimate, suggestions, prefilledFields, auditData }: AcquisitionDateCardProps) {
	const current = estimate ? isEstimateCurrent(estimate, dataset) : false;
	const suggestion = datasetDateSuggestion(estimate, dataset);
	const applied = auditData?.accept_suggested_acquisition_date === true && auditData.original_acquisition_date;

	return (
		<Card size="small" className="mb-3 shadow-sm">
			<div className="mb-2 flex items-center">
				<Text strong className="text-xs">2. Acquisition Date</Text>
			</div>
			<div className="mb-2 text-xs">
				<Text type="secondary">Reported date: </Text>
				<Text strong>{formatAcquisitionDate(dataset)}</Text>
				{applied && (
					<Text type="secondary"> (was {formatAcquisitionDate({
						aquisition_year: auditData.original_acquisition_date?.year,
						aquisition_month: auditData.original_acquisition_date?.month,
						aquisition_day: auditData.original_acquisition_date?.day,
					})} before the suggested date was accepted)</Text>
				)}
			</div>

			{estimate ? (
				<EstimateSummary estimate={estimate} dataset={dataset} />
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
			{estimate && !current && !applied && (
				<div className="mb-2 text-[11px] text-gray-500">
					The estimate was made for a different reported date; the suggestion is hidden until the stage reruns.
				</div>
			)}

			<div className="flex items-center text-xs">
				<Text type="secondary">Reported date valid?</Text>
				<SuggestedTag field="has_valid_acquisition_date" suggestions={suggestions} prefilledFields={prefilledFields} />
			</div>
			<Form.Item
				name="has_valid_acquisition_date"
				className="mb-2"
				rules={createConditionalRule("Please validate acquisition date")}
			>
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
							Suggested date:{" "}
							<Text strong>
								{suggestion
									? formatIsoDate(suggestion.date)
									: formatAcquisitionDate({
											aquisition_year: auditData?.applied_acquisition_date?.year,
											aquisition_month: auditData?.applied_acquisition_date?.month,
											aquisition_day: auditData?.applied_acquisition_date?.day,
										})}
							</Text>
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
