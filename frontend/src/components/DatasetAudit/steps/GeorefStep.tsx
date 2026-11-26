import { Form, Input, Radio } from "antd";
import type { IGeorefCheck } from "../../../types/georefCheck";
import { GEOREF_LABELS, GEOREF_PASS_M } from "../../../utils/auditReview";
import { describeReference, orderedReferences, summarizeGeorefCheck } from "../../../utils/georefCheck";
import { StepHeading } from "./EvaluationStep";

interface GeorefStepProps {
	/** the stored check (v2_georef_checks): the references and their offsets */
	check: IGeorefCheck | null | undefined;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** What the offset rests on: one row per reference (offset on 90% of the matched area, how much
 * of the image matched, whether it decides), plus the references that could not be read. */
function GeorefFacts({ check }: { check: IGeorefCheck }) {
	const references = orderedReferences(check);
	const missing = Object.entries(check.reference_errors);
	return (
		<div className="flex flex-col gap-1 text-xs" data-testid="audit-georef-facts">
			<div className="text-gray-700">{summarizeGeorefCheck(check).detail}</div>
			{references.length > 0 && (
				<table className="w-full text-[11px]">
					<thead className="text-left text-gray-500">
						<tr>
							<th className="font-normal">Reference</th>
							<th className="font-normal">Offset (90%)</th>
							<th className="font-normal">Matched</th>
							<th className="font-normal">Counts</th>
						</tr>
					</thead>
					<tbody>
						{references.map((r) => (
							<tr key={r.provider} className={r.decides ? "font-medium" : "text-gray-500"}>
								<td>{describeReference(check, r.provider)}</td>
								<td className="tabular-nums">{r.p90_m === null ? "–" : `${r.p90_m.toFixed(1)} m`}</td>
								<td className="tabular-nums">
									{percent(r.support)} · {r.inliers} matches
								</td>
								<td>{r.decides ? "yes" : (r.reason?.replace(/_/g, " ") ?? "no")}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{missing.length > 0 && <div className="text-[11px] text-gray-500">Not available: {missing.map(([p, e]) => `${p} (${e.replace(/_/g, " ")})`).join(", ")}</div>}
		</div>
	);
}

/** Step 3: the georeferencing output, an offset in metres, "no reference", or "needs review"
 * when no reference decides. A reviewer answers it Passed (within 15 m) or Not passed; the map
 * shows the references and the matches while the step is open. */
export default function GeorefStep({ check }: GeorefStepProps) {
	return (
		<div className="flex flex-col gap-2" data-testid="audit-georef-step">
			{check ? <GeorefFacts check={check} /> : <div className="text-xs text-gray-500">No georeferencing check yet (processing stage georef_check_v1).</div>}
			<div>
				<StepHeading>Human decision (too little evidence, no reference or an incorrect reference)</StepHeading>
				<Form.Item name="georefStatus" className="mb-1">
					<Radio.Group optionType="button" buttonStyle="solid" size="small">
						<Radio.Button value="passed">{GEOREF_LABELS.passed}</Radio.Button>
						<Radio.Button value="not_passed">{GEOREF_LABELS.not_passed}</Radio.Button>
					</Radio.Group>
				</Form.Item>
				<Form.Item name="georefNote" className="mb-0">
					<Input size="small" maxLength={2000} aria-label="Note on the georeferencing" placeholder={`Note (optional), e.g. which reference shows the offset over ${GEOREF_PASS_M} m`} />
				</Form.Item>
			</div>
		</div>
	);
}
