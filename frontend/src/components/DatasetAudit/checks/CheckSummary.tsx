import type { IAuditCheckEvidence } from "../../../types/auditChecks";
import { LAYER_LABELS, automatedRows, automatedVerdict, verdictLabel, type IAuditSectionDef } from "../../../utils/auditChecks";

const words = (value: unknown) => (typeof value === "string" ? value.replace(/_/g, " ") : null);

/** What a "keep, fix" verdict asks to be fixed (the rule row's details.fix_flags). */
const FIX_LABELS: Record<string, string> = { cog_issue: "COG issue", thumbnail_issue: "thumbnail issue", reprocess: "reprocess" };
const fixes = (value: unknown) =>
	Array.isArray(value) && value.length ? value.map((flag) => FIX_LABELS[String(flag)] ?? words(flag)).join(", ") : null;

/** One line per layer on the check's call and what it rests on; why a person sees it is in the step's details. */
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
				// a prediction step has no whole-layer verdict: only what the crops say
				if (section.cropAnswers) return crops ? <div key={layer}>The check counts {crops}.</div> : null;
				const toFix = verdict === "minor" ? fixes(details.fix_flags) : null;
				const because = [words(details.reason), crops, words(details.summary)].filter(Boolean).join("; ");
				return (
					<div key={layer}>
						{section.layers.length > 1 && <span>{LAYER_LABELS[layer]}: </span>}
						<b>
							{verdict ? verdictLabel(checkKey, verdict) : "No call"}
							{toFix && `: ${toFix}`}
						</b>
						{because && <span>. {because.charAt(0).toUpperCase() + because.slice(1)}</span>}
					</div>
				);
			})}
		</div>
	);
}
