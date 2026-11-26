import type { IAuditAssessment } from "../../../types/auditChecks";

const when = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Who gave a benchmark target its label and when. The label is the latest answer: a new one replaces it. */
export default function LabeledBy({ row }: { row: IAuditAssessment }) {
	return (
		<div className="text-xs text-gray-600" data-testid="benchmark-labeled-by">
			Labeled by {(row.assessor_email ?? "a labeler").split("@")[0]}
			{row.created_at ? ` on ${when(row.created_at)}` : ""}. A new answer replaces the label.
		</div>
	);
}
