import { Button, Form, Radio } from "antd";
import NoteField from "./NoteField";
import type { AuditFormValues, DatasetDisposition } from "../../../hooks/useDatasetAudit";
import type { AuditVerdict } from "../../../types/auditChecks";
import { DISPOSITION_LABELS, deriveDecision } from "../../../utils/auditChecks";


interface DerivedDecisionProps {
	/** the dataset evaluation's call: the reviewer's answer, else the check's */
	evaluation: AuditVerdict | null;
	/** sections whose check waits for this reviewer */
	needsYou: number;
}

const BOX: Record<DatasetDisposition | "open", string> = {
	no_issues: "bg-green-50 text-green-900",
	fixable_issues: "bg-amber-50 text-amber-900",
	exclude_completely: "bg-red-50 text-red-900",
	open: "bg-slate-100 text-slate-800",
};

/** The final assessment the sections add up to, at the top of the sidebar. The reviewer
 * confirms it or picks another; the saved audit stores what they chose. */
export default function DerivedDecision({ evaluation, needsYou }: DerivedDecisionProps) {
	const form = Form.useFormInstance<AuditFormValues>();
	const values = Form.useWatch((v: AuditFormValues) => v, { form, preserve: true }) ?? {};
	const chosen = values.final_assessment;
	const { disposition, because, open } = deriveDecision(values, evaluation);
	const headline = disposition
		? `${DISPOSITION_LABELS[disposition]}${because.length ? `: ${because.join(", ")}` : ""}`
		: "Not decided yet";
	const counts = [needsYou ? `${needsYou} section${needsYou > 1 ? "s" : ""} need you` : null, open.length ? `open: ${open.join(", ")}` : null]
		.filter(Boolean)
		.join(" · ");

	// Fix, Exclude and overriding the derived decision need a note; otherwise it is optional
	const needsNotes = chosen === "fixable_issues" || chosen === "exclude_completely" || (!!chosen && !!disposition && chosen !== disposition);

	return (
		<div className={`mb-3 rounded-lg px-3 py-2.5 ${BOX[disposition ?? "open"]}`} data-testid="audit-decision">
			<div className="text-[11px] uppercase tracking-wide opacity-80">Decision, derived from the checks</div>
			<div className="text-base font-bold">{headline}</div>
			{counts && <div className="text-xs opacity-90">{counts}</div>}
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<Button
					size="small"
					type="primary"
					disabled={!disposition || chosen === disposition}
					onClick={() => form.setFieldsValue({ final_assessment: disposition! })}
				>
					{chosen && chosen === disposition ? "Confirmed" : "Confirm"}
				</Button>
				<span className="text-xs">or choose:</span>
				<Form.Item name="final_assessment" className="mb-0" rules={[{ required: true, message: "Confirm or choose the final assessment" }]}>
					<Radio.Group size="small" optionType="button">
						{(Object.keys(DISPOSITION_LABELS) as DatasetDisposition[]).map((d) => (
							<Radio.Button key={d} value={d}>
								{DISPOSITION_LABELS[d]}
							</Radio.Button>
						))}
					</Radio.Group>
				</Form.Item>
			</div>
			{chosen && disposition && chosen !== disposition && (
				<div className="mt-1 text-xs">You override the derived decision ({DISPOSITION_LABELS[disposition]}). Say why in the notes.</div>
			)}
			<div className="mt-2">
				<NoteField
					name="notes"
					required={needsNotes}
					label="Add a note"
					placeholder={needsNotes ? "Notes (required for Fix, Exclude and an override): what needs fixing or why it goes" : "Notes on the decision..."}
				/>
			</div>
		</div>
	);
}
