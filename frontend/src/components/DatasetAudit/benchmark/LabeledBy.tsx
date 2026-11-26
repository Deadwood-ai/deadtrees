const when = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Who gave a benchmark target its label and when. The label is the newest answer: a new one replaces it. */
export default function LabeledBy({ review }: { review: { reviewer_email?: string | null; created_at: string } }) {
	return (
		<div className="text-xs text-gray-600" data-testid="benchmark-labeled-by">
			Labeled by {(review.reviewer_email ?? "a labeler").split("@")[0]} on {when(review.created_at)}. A new answer replaces the label.
		</div>
	);
}
