import { Alert } from "antd";
import type { IAuditReviewItem, IAuditSuggestion } from "../../types/acquisitionDate";

interface AuditReviewNoticeProps {
	items: IAuditReviewItem[];
	suggestions: IAuditSuggestion[];
	saved: Record<string, unknown> | null | undefined;
}

const FIELD_LABELS: Record<string, string> = {
	is_georeferenced: "Georeferencing",
	has_valid_phenology: "Phenology / season",
	deadwood_quality: "Deadwood prediction quality",
	forest_cover_quality: "Tree cover prediction quality",
	has_cog_issue: "COG issues",
	has_thumbnail_issue: "Thumbnail issues",
	final_assessment: "Final assessment",
};

const show = (v: unknown) => (v === true ? "yes" : v === false ? "no" : v === null || v === undefined ? "empty" : String(v));

/** Audit items that newer machine evidence disagrees with, other than the
 * acquisition date (its card explains itself). The form already shows the
 * suggested value; saving the audit takes the item off the re-review list. */
export function AuditReviewNotice({ items, suggestions, saved }: AuditReviewNoticeProps) {
	const rows = items
		.filter((i) => i.item !== "acquisition_date")
		.map((i) => ({ item: i, suggestion: suggestions.find((s) => s.field === i.item) }));
	if (!rows.length) return null;
	return (
		<Alert
			type="info"
			showIcon
			className="mb-3 text-xs"
			message="Needs re-review: newer evidence disagrees with the saved audit"
			description={
				<ul className="m-0 pl-4">
					{rows.map(({ item, suggestion }) => (
						<li key={item.item}>
							{FIELD_LABELS[item.item] ?? item.item}: saved {show(saved?.[item.item])}, now suggested{" "}
							<b>{show(suggestion?.value)}</b>
							{suggestion ? ` (${suggestion.source}, ${suggestion.reason ?? "no reason given"})` : ""}. The form shows the suggestion.
						</li>
					))}
				</ul>
			}
		/>
	);
}
