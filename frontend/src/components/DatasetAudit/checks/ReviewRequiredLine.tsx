import type { ReviewItem } from "../../../types/auditChecks";
import { reviewRequiredText } from "../../../utils/auditReview";

interface ReviewRequiredLineProps {
	/** the review items still open, with the ones answered on the page already taken out */
	items: ReviewItem[];
	/** audit.dataset_outcomes could not be read: say so instead of "No review required" */
	unknown?: boolean;
}

/** The top line of the sidebar: what still needs a person on this dataset. It follows your
 * answers on the page and the stored results after Save. */
export default function ReviewRequiredLine({ items, unknown }: ReviewRequiredLineProps) {
	const tone = unknown ? "bg-slate-100 text-slate-700" : items.length ? "bg-amber-50 text-amber-900" : "bg-green-50 text-green-900";
	return (
		<div className={`mb-3 rounded-lg px-3 py-2 text-sm font-semibold ${tone}`} data-testid="audit-review-required" role="status">
			{unknown ? "Whether a review is required can’t be read here yet" : reviewRequiredText(items)}
		</div>
	);
}
