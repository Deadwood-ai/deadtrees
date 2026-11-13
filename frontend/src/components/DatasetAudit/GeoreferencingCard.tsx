import { Form, Radio, Space, Typography } from "antd";
import { createConditionalRule } from "./auditConstants";
import { SuggestedTag } from "./AcquisitionDateCard";
import { ReviewChange, ReviewTag } from "./AuditReviewNotice";
import { describeReference, orderedReferences, summarizeGeorefCheck } from "../../utils/georefCheck";
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
	/** the audit check ran: its call and answer row above replace this card's check box and radio,
	 * and the answer decides the field */
	byCheck?: boolean;
}

const TONE_BOX = {
	success: "border-green-200 bg-green-50",
	error: "border-red-200 bg-red-50",
	warning: "border-amber-200 bg-amber-50",
} as const;

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** What the georeferencing call rests on, under the step's answer row: the evidence in one line and
 * one row per reference (offset on 90% of the matched area, how much of the image matched, whether
 * it decides), plus the references that could not be read. Good is under 15 m. */
function GeorefFacts({ check, detail }: { check: IGeorefCheck; detail: string }) {
	const references = orderedReferences(check);
	const missing = Object.entries(check.reference_errors);
	return (
		<div className="mb-2 flex flex-col gap-1 text-xs" data-testid="audit-georef-facts">
			<div className="text-gray-700">{detail} Good is under 15 m.</div>
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

/** The georeferencing check's call and the saved answer; the map shows the matching while the section is open. */
export function GeoreferencingCard({ check, suggestions, prefilledFields, reviewItems, saved, byCheck }: GeoreferencingCardProps) {
	const summary = check ? summarizeGeorefCheck(check) : null;
	const underReview = reviewItems.some((i) => i.item === "is_georeferenced");
	return (
		<div>
			<ReviewChange field="is_georeferenced" items={reviewItems} suggestions={suggestions} saved={saved} />
			{!byCheck && (
				<>
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
				<Text type="secondary">Saved audit</Text>
				{underReview ? (
					<ReviewTag item="is_georeferenced" items={reviewItems} />
				) : (
					<SuggestedTag field="is_georeferenced" suggestions={suggestions} prefilledFields={prefilledFields} />
				)}
			</div>
				</>
			)}
			{byCheck && check && summary && <GeorefFacts check={check} detail={summary.detail} />}
			<Form.Item name="is_georeferenced" className="mb-0" hidden={byCheck} rules={createConditionalRule("Please assess georeferencing")}>
				<Radio.Group>
					<Space size="large">
						<Radio value={true}>🟢 Good (&lt;15m)</Radio>
						<Radio value={false}>🔴 Poor (&gt;15m)</Radio>
					</Space>
				</Radio.Group>
			</Form.Item>
		</div>
	);
}
