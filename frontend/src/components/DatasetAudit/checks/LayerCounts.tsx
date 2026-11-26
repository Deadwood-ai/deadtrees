import { share } from "../../../utils/auditReview";
import type { ILayerCounts } from "../../../utils/cropCalls";

interface LayerCountsProps {
	counts: ILayerCounts | null;
	/** what the counts rest on, e.g. "with your answers" */
	caption?: string;
}

const PARTS = [
	["major", "Major", "text-red-700"],
	["minor", "Minor", "text-amber-700"],
	["ok", "OK", "text-green-700"],
] as const;

/** A prediction layer's crop counts: Total, Major (%), Minor (%), OK (%), and your Ambiguous
 * answers, which are not in the total. */
export default function LayerCounts({ counts, caption }: LayerCountsProps) {
	if (!counts) return <span className="text-xs text-gray-500">The check has not judged crops of this layer yet.</span>;
	return (
		<span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs" data-testid="audit-layer-counts">
			<span>
				Total <b>{counts.total}</b>
			</span>
			{PARTS.map(([key, label, color]) => (
				<span key={key} className={color}>
					{label} <b>{counts[key]}</b> ({share(counts[key], counts.total) ?? 0}%)
				</span>
			))}
			{!!counts.ambiguous && (
				<span className="text-slate-600">
					Ambiguous <b>{counts.ambiguous}</b>
				</span>
			)}
			{caption && <span className="text-gray-500">{caption}</span>}
		</span>
	);
}
