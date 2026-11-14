import { Collapse } from "antd";
import { useAuth } from "../../../hooks/useAuthProvider";
import type { IAuditAssessment, IAuditCheckEvidence } from "../../../types/auditChecks";
import {
	LAYER_LABELS,
	QUEUE_REASONS,
	automatedRows,
	evaluationAnswerText,
	othersAnswers,
	verdictLabel,
	type IAuditSectionDef,
} from "../../../utils/auditChecks";

/** An answer in a few words: the dataset evaluation's own wording, else the verdict and the reason. */
function answerText(section: IAuditSectionDef, row: IAuditAssessment): string {
	if (section.checkKey === "dataset_evaluation") return evaluationAnswerText(row);
	const reason = row.reason_code ? section.reasons.find((r) => r.code === row.reason_code)?.label ?? row.reason_code : null;
	return `${verdictLabel(section.checkKey!, row.verdict)}${reason ? ` (${reason})` : ""}${row.reason_text ? `, “${row.reason_text}”` : ""}`;
}

/** Everything behind a step's call, collapsed: why a person sees it, each model's answer and the
 * other reviewers' answers. Collapsed by default, so a reviewer decides before seeing the others. */
export default function AnswerDetails({ section, evidence, people }: { section: IAuditSectionDef; evidence: IAuditCheckEvidence; people: IAuditAssessment[] }) {
	const { user } = useAuth();
	const rows = section.layers.map((layer) => {
		const queued = evidence.queue.find((q) => q.layer === layer);
		const models = automatedRows(evidence, layer).filter((r) => r.assessor_kind === "model");
		const others = othersAnswers(people, user?.id, evidence.run.id, { checkKey: section.checkKey!, layer });
		return { layer, queued, models, others };
	});
	return (
		<Collapse
			ghost
			size="small"
			className="-mx-3 text-[11px]"
			items={[
				{
					key: "details",
					label: <span className="text-[11px] text-gray-500">Details: models and other reviewers</span>,
					children: (
						<div className="flex flex-col gap-1.5 text-[11px] text-gray-600">
							{rows.map(({ layer, queued, models, others }) => (
								<div key={layer}>
									{section.layers.length > 1 && <div className="font-medium text-gray-700">{LAYER_LABELS[layer]}</div>}
									{queued?.reason && <div>Here because {QUEUE_REASONS[queued.reason].because}.</div>}
									<div>
										Models:{" "}
										{models.length
											? models.map((m) => `${m.model}: ${answerText(section, m)}`).join(" · ")
											: section.cropAnswers
												? "they judge each crop; pick a crop to see what they saw"
												: "none"}
									</div>
									<div>
										Other reviewers:{" "}
										{others.length ? others.map((a) => `${a.assessor_email ?? "a reviewer"}: ${answerText(section, a)}`).join(" · ") : "no answers yet"}
									</div>
								</div>
							))}
						</div>
					),
				},
			]}
		/>
	);
}
