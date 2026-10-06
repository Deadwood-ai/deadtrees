import { Alert, Tag, Tooltip } from "antd";
import { SyncOutlined } from "@ant-design/icons";
import type { IAuditReviewItem, IAuditSuggestion } from "../../types/acquisitionDate";

const FIELD_LABELS: Record<string, string> = {
	acquisition_date: "Acquisition date",
	is_georeferenced: "Georeferencing",
	has_valid_phenology: "Phenology / season",
	deadwood_quality: "Deadwood prediction quality",
	forest_cover_quality: "Tree cover prediction quality",
	has_cog_issue: "COG issues",
	has_thumbnail_issue: "Thumbnail issues",
	final_assessment: "Final assessment",
};

/** Readable name of an audit item (audit_review_queue.item / dataset_audit field). */
export const auditItemLabel = (item: string) => FIELD_LABELS[item] ?? item.replace(/_/g, " ");

const VALUE_LABELS: Record<string, [string, string]> = {
	is_georeferenced: ["Good", "Poor"],
	has_valid_acquisition_date: ["Valid", "Invalid"],
};

/** An audit value as the form shows it ("Good"/"Poor" for georeferencing). */
export function auditValueLabel(field: string, value: unknown): string {
	if (value === null || value === undefined) return "empty";
	if (typeof value === "boolean") return (VALUE_LABELS[field] ?? ["yes", "no"])[value ? 0 : 1];
	return String(value);
}

interface AuditReviewNoticeProps {
	items: IAuditReviewItem[];
}

/** One line at the top of the form naming the sections newer evidence disagrees
 * with; each section explains its own item. Saving the audit takes the dataset
 * off the re-review list. */
export function AuditReviewNotice({ items }: AuditReviewNoticeProps) {
	const labels = [...new Set(items.map((i) => auditItemLabel(i.item)))];
	if (!labels.length) return null;
	return (
		<Alert
			type="warning"
			showIcon
			icon={<SyncOutlined />}
			className="mb-3 py-1 text-xs"
			message={
				<span className="text-xs">
					<b>Re-review {labels.join(", ")}:</b> newer evidence disagrees with the saved audit. Saving records your decision.
				</span>
			}
		/>
	);
}

interface ReviewTagProps {
	/** the audit item (audit_review_queue.item) the section owns */
	item: string;
	items: IAuditReviewItem[];
}

/** Section-title tag for an item under re-review. */
export function ReviewTag({ item, items }: ReviewTagProps) {
	if (!items.some((i) => i.item === item)) return null;
	return (
		<Tooltip title="Newer evidence disagrees with the saved audit">
			<Tag icon={<SyncOutlined />} color="orange" className="ml-2 text-[10px]">
				re-review
			</Tag>
		</Tooltip>
	);
}

interface ReviewChangeProps {
	field: string;
	items: IAuditReviewItem[];
	suggestions: IAuditSuggestion[];
	saved: Record<string, unknown> | null | undefined;
}

/** "Saved Good, now suggested Poor" for a field under re-review. */
export function ReviewChange({ field, items, suggestions, saved }: ReviewChangeProps) {
	const suggestion = suggestions.find((s) => s.field === field);
	if (!suggestion || !items.some((i) => i.item === field)) return null;
	return (
		<div className="mb-1 text-[11px] text-orange-700">
			Saved audit: <b>{auditValueLabel(field, saved?.[field])}</b>. Now suggested: <b>{auditValueLabel(field, suggestion.value)}</b>; the form shows
			the suggestion.
		</div>
	);
}
