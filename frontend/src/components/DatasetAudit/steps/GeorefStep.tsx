import { Form, Input, Radio } from "antd";
import type { IAuditDatasetResult } from "../../../types/auditChecks";
import type { IGeorefCheck } from "../../../types/georefCheck";
import { GEOREF_ANSWERS, GEOREF_LABELS, GEOREF_PASS_M, georefCheckSentence } from "../../../utils/auditReview";
import { describeReference, orderedReferences } from "../../../utils/georefCheck";
import { StepHeading } from "./EvaluationStep";

interface GeorefStepProps {
	/** the stored check (v2_georef_checks): the references and their offsets */
	check: IGeorefCheck | null | undefined;
	/** the dataset's row of audit.dataset_outcomes: the check's output */
	result: IAuditDatasetResult | null | undefined;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** What the offset rests on: one row per reference (offset on 90% of the matched area, how much
 * of the area of interest matched, how many matches agree with the fitted shift and how widely
 * they spread over the image), plus the references that could not be read. */
function GeorefFacts({ check }: { check: IGeorefCheck }) {
	const references = orderedReferences(check);
	const missing = Object.entries(check.reference_errors);
	return (
		<div className="flex flex-col gap-1 text-xs" data-testid="audit-georef-facts">
			{references.length > 0 && (
				<table className="w-full text-[11px]">
					<thead className="text-left text-gray-500">
						<tr>
							<th className="font-normal">Reference</th>
							<th className="font-normal">Offset (90%)</th>
							<th className="font-normal">Area matched</th>
							<th className="font-normal">Consistent matches</th>
							<th className="font-normal">Spread</th>
						</tr>
					</thead>
					<tbody>
						{references.map((r) => (
							<tr key={r.provider} className={r.p90_m === null ? "text-gray-500" : undefined}>
								<td>{describeReference(check, r.provider)}</td>
								<td className="tabular-nums">{r.p90_m === null ? "–" : `${r.p90_m.toFixed(1)} m`}</td>
								<td className="tabular-nums">{percent(r.support)}</td>
								<td className="tabular-nums">
									{r.inliers} of {r.matches} ({percent(r.inlier_fraction)})
								</td>
								<td className="tabular-nums">{r.cells} of 16 cells</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{missing.length > 0 && <div className="text-[11px] text-gray-500">Not available: {missing.map(([p, e]) => `${p} (${e.replace(/_/g, " ")})`).join(", ")}</div>}
		</div>
	);
}

/** Step 3: the check's estimated offset, that the references matched too poorly for one (needs
 * review), or that no reference imagery matched. A reviewer may answer Passed (within 15 m), Not passed or
 * No reference imagery; the map shows the references and the matches while the step is open. */
export default function GeorefStep({ check, result }: GeorefStepProps) {
	const sentence = georefCheckSentence(result);
	return (
		<div className="flex flex-col gap-2" data-testid="audit-georef-step">
			{sentence && <div className="text-xs text-gray-700">{sentence}</div>}
			{check ? <GeorefFacts check={check} /> : <div className="text-xs text-gray-500">No georeferencing check yet (processing stage georef_check_v1).</div>}
			<div>
				<StepHeading>Your answer (optional)</StepHeading>
				<Form.Item name="georefStatus" className="mb-1">
					<Radio.Group optionType="button" buttonStyle="solid" size="small">
						{GEOREF_ANSWERS.map((answer) => (
							<Radio.Button key={answer} value={answer}>
								{GEOREF_LABELS[answer]}
							</Radio.Button>
						))}
					</Radio.Group>
				</Form.Item>
				<Form.Item name="georefNote" className="mb-0">
					<Input size="small" maxLength={2000} aria-label="Note on the georeferencing" placeholder={`Note (optional), e.g. which reference shows the offset over ${GEOREF_PASS_M} m`} />
				</Form.Item>
			</div>
		</div>
	);
}
