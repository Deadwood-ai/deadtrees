import type { IAuditDatasetResult, IAuditReviews } from "../../../types/auditChecks";
import { reviewChanges } from "../../../utils/reviewChanges";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Under the review line: what the review set or overrode, by whom and when, one line per step.
 * Nothing while nobody has reviewed the dataset. */
export default function ReviewChanges({ reviews, result }: { reviews: IAuditReviews | undefined; result: IAuditDatasetResult | null | undefined }) {
	const changes = reviewChanges(reviews, result);
	if (!changes.length) return null;
	return (
		<div className="mb-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] text-gray-700" data-testid="audit-review-changes">
			<div className="mb-0.5 font-semibold uppercase tracking-wide text-gray-500">Set by the review</div>
			{changes.map((c) => (
				<div key={c.step} className="flex flex-wrap gap-x-1">
					<span className="font-medium">{c.step}:</span>
					<span>{c.value}</span>
					<span className="text-gray-500">
						· {c.by} · {when(c.at)}
					</span>
				</div>
			))}
		</div>
	);
}
