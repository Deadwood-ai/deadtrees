import type { IAuditCheckEvidence, IAuditQueueRow } from "../../../types/auditChecks";
import { LAYER_LABELS, automatedRows, automatedVerdict, verdictLabel, type IAuditSectionDef } from "../../../utils/auditChecks";

const WHY_HERE: Record<NonNullable<IAuditQueueRow["reason"]>, string> = {
	review_all: "every result of this check goes to a person for now",
	unsure: "the check is unsure",
	models_disagree: "the models disagree",
	spot_check: "spot check",
};

const words = (value: unknown) => (typeof value === "string" ? value.replace(/_/g, " ") : null);

/** One line per layer on the check's call, with what it rests on and why a person sees it. */
export default function CheckSummary({ section, evidence }: { section: IAuditSectionDef; evidence: IAuditCheckEvidence }) {
	const checkKey = section.checkKey!;
	return (
		<div className="flex flex-col gap-1 text-xs text-gray-700">
			{section.layers.map((layer) => {
				const verdict = automatedVerdict(evidence, layer);
				const [first] = automatedRows(evidence, layer);
				const details = first?.details ?? {};
				const crops =
					typeof details.major_crops === "number" && typeof details.judged_crops === "number"
						? `${details.major_crops} of ${details.judged_crops} crops major`
						: null;
				const because = [words(details.reason), crops, words(details.summary)].filter(Boolean).join("; ");
				const queued = evidence.queue.find((q) => q.layer === layer);
				return (
					<div key={layer}>
						{section.layers.length > 1 && <span>{LAYER_LABELS[layer]}: </span>}
						<b>{verdict ? verdictLabel(checkKey, verdict) : "No call"}</b>
						{because && <span>. {because.charAt(0).toUpperCase() + because.slice(1)}</span>}
						{queued?.reason && <span className="text-gray-500"> · Here because {WHY_HERE[queued.reason]}.</span>}
					</div>
				);
			})}
		</div>
	);
}
