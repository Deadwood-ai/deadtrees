import { Collapse, Form, Input, Radio } from "antd";
import type { IDataset } from "../../../types/dataset";
import type { IAcquisitionDateEstimate } from "../../../types/acquisitionDate";
import type { IAuditDatasetResult } from "../../../types/auditChecks";
import { describeModelType, formatIsoDate, joinYearWrap } from "../../../utils/acquisitionDate";
import type { IReviewDraft } from "../../../utils/auditReview";
import { AERIALSTAMP_CITATION, AERIALSTAMP_REPO } from "../../../data/citations";
import AcquisitionDateDistribution from "../../AcquisitionDate/AcquisitionDateDistribution";
import CitationText from "../../Citation/CitationText";
import { formatAcquisitionDate } from "../auditConstants";
import { StepHeading } from "./EvaluationStep";

interface DateStepProps {
	dataset: IDataset;
	result: IAuditDatasetResult | null | undefined;
	/** the stored estimate (v2_acquisition_date_estimates) behind the output, for its curve */
	estimate: IAcquisitionDateEstimate | null | undefined;
}

const pad = (v: number | string) => String(v).padStart(2, "0");
const reportedIso = (d: IDataset) => (d.aquisition_year && d.aquisition_month && d.aquisition_day ? `${d.aquisition_year}-${pad(d.aquisition_month)}-${pad(d.aquisition_day)}` : null);
const isoDay = (iso: string | null | undefined) => (iso ? formatIsoDate(iso.slice(0, 10)) : "–");

/** Step 4: AerialStamp's acquisition date output: replace the reported date or not, and the new
 * date. Nothing here changes the dataset's date; a reviewer may override "replace" with a note. */
export default function DateStep({ dataset, result, estimate }: DateStepProps) {
	const form = Form.useFormInstance<IReviewDraft>();
	const replace = Form.useWatch("dateReplace", form);
	const note = Form.useWatch("dateNote", form);
	const overriding = typeof replace === "boolean" && result?.date_replace != null && replace !== result.date_replace;
	const ranges = joinYearWrap(estimate?.hdi["80"] ?? [])
		.map(([s, e]) => `${formatIsoDate(s, { day: "numeric", month: "short" })} – ${formatIsoDate(e, { day: "numeric", month: "short" })}`)
		.join(", ");

	return (
		<div className="flex flex-col gap-2" data-testid="audit-date-step">
			<div className="text-xs">
				<div>
					Reported date: <b>{formatAcquisitionDate(dataset)}</b>
				</div>
				{result?.date_replace == null ? (
					<div className="text-gray-500">AerialStamp has not dated this dataset yet (processing stage doy_estimation_v1).</div>
				) : (
					<div data-testid="audit-date-output">
						Replace: <b>{result.date_replace ? `Yes, with ${isoDay(result.date_new)}` : "No"}</b>
					</div>
				)}
				{result?.date_predicted && (
					<div className="text-gray-600">
						Predicted {isoDay(result.date_predicted)}
						{result.date_hdi80_days != null && `, 80% within ${result.date_hdi80_days} days`}
					</div>
				)}
				<div className="text-[11px] text-gray-500">
					Model {result?.date_model_version ?? estimate?.model_version ?? "–"}
					{estimate && ` (${describeModelType(estimate)})`} · run {isoDay(result?.date_estimated_at ?? estimate?.updated_at)}
				</div>
			</div>

			{estimate && (
				<div>
					<AcquisitionDateDistribution estimate={estimate} recordedDate={reportedIso(dataset)} />
					<div className="text-[11px] text-gray-500">
						80% likely: {ranges} ({estimate.hdi80_days} days){estimate.n_modes > 1 && " · several plausible seasons"}
					</div>
				</div>
			)}

			{result?.date_replace != null && (
				<div>
					<StepHeading>Human decision</StepHeading>
					<Form.Item name="dateReplace" className="mb-1">
						<Radio.Group optionType="button" buttonStyle="solid" size="small">
							<Radio.Button value={true}>Replace the date</Radio.Button>
							<Radio.Button value={false}>Keep the reported date</Radio.Button>
						</Radio.Group>
					</Form.Item>
					<Form.Item name="dateNote" className="mb-0">
						<Input
							size="small"
							maxLength={2000}
							status={overriding && !note?.trim() ? "warning" : undefined}
							aria-label="Note on the date override"
							placeholder={overriding ? "Why you override AerialStamp (required)" : "Note (needed only for an override)"}
						/>
					</Form.Item>
				</div>
			)}

			<Collapse
				ghost
				size="small"
				className="-mx-3"
				items={[
					{
						key: "cite",
						label: <span className="text-[11px] text-gray-500">About AerialStamp and how to cite it</span>,
						children: (
							<div className="flex flex-col gap-2 text-xs" data-testid="aerialstamp-citation">
								<div>
									AerialStamp estimates the acquisition date of an orthophoto as a probability distribution over the flight year:{" "}
									<a href={AERIALSTAMP_CITATION.url} target="_blank" rel="noopener noreferrer">
										{AERIALSTAMP_CITATION.short}
									</a>
									,{" "}
									<a href={AERIALSTAMP_REPO} target="_blank" rel="noopener noreferrer">
										code
									</a>
									.
								</div>
								<CitationText label="BibTeX" text={AERIALSTAMP_CITATION.bibtex} compact />
								<CitationText label="APA" text={AERIALSTAMP_CITATION.apa} compact />
							</div>
						),
					},
				]}
			/>
		</div>
	);
}
