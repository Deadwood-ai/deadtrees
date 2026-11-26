import { Badge, Button, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { AuditListTab, IAuditListRow } from "../../../utils/auditReviewList";
import {
	DECISION_LABELS,
	REVIEW_ITEM_LABELS,
	SOURCE_LABELS,
	georefText,
	layerResult,
	share,
} from "../../../utils/auditReview";
import { formatIsoDate } from "../../../utils/acquisitionDate";
import type { PredictionLayer } from "../../../types/auditChecks";

const DECISION_COLORS = { keep: "green", exclude: "red" } as const;
const NONE = <span className="text-gray-400">—</span>;

const location = (row: IAuditListRow) => [row.dataset.admin_level_3, row.dataset.admin_level_1].filter(Boolean).join(", ") || "Unknown";

function acquisitionDate(row: IAuditListRow): string {
	const { aquisition_year: y, aquisition_month: m, aquisition_day: d } = row.dataset;
	if (!y) return "Unknown";
	return [y, m, d].filter(Boolean).map((part, i) => (i ? String(part).padStart(2, "0") : String(part))).join("-");
}

const numberOr = (value: number | null | undefined, fallback = -1) => (typeof value === "number" ? value : fallback);

function LayerCell({ row, layer }: { row: IAuditListRow; layer: PredictionLayer }) {
	const counts = layerResult(row.result, layer);
	if (!counts) return NONE;
	return (
		<Tooltip title={`Major ${counts.major}, minor ${counts.minor}, OK ${counts.ok} of ${counts.total} crops`}>
			<span className={counts.major ? "text-red-700" : ""}>
				{counts.major}/{counts.total} ({share(counts.major, counts.total)}%)
			</span>
		</Tooltip>
	);
}

const layerShare = (row: IAuditListRow, layer: PredictionLayer) => {
	const counts = layerResult(row.result, layer);
	return counts ? (share(counts.major, counts.total) ?? -1) : -1;
};

/** The table's columns: the same in every tab; Edits & flags adds the count of user reports and
 * edits, the segmentation benchmark the patch editor. */
export function auditListColumns({
	tab,
	onOpen,
	onReferencePatches,
}: {
	tab: AuditListTab;
	onOpen: (id: number) => void;
	/** the reference tab: open the reference patch editor */
	onReferencePatches?: (id: number) => void;
}): ColumnsType<IAuditListRow> {
	const columns: ColumnsType<IAuditListRow> = [
		{ title: "ID", dataIndex: "id", key: "id", width: 80, sorter: (a, b) => a.id - b.id, defaultSortOrder: "descend" },
		{
			title: "Location",
			key: "location",
			width: 170,
			render: (_, row) => <span className="text-sm">{location(row)}</span>,
			sorter: (a, b) => location(a).localeCompare(location(b)),
		},
		{
			title: "Acquired",
			key: "date",
			width: 100,
			render: (_, row) => <span className="font-mono text-xs">{acquisitionDate(row)}</span>,
			sorter: (a, b) => acquisitionDate(a).localeCompare(acquisitionDate(b)),
		},
		{
			title: "Evaluation",
			key: "evaluation",
			width: 120,
			render: (_, row) => {
				const decision = row.result?.evaluation_decision;
				if (!decision) return NONE;
				const source = row.result?.evaluation_source;
				return (
					<Tooltip title={source ? `by ${SOURCE_LABELS[source]}` : undefined}>
						<Tag color={DECISION_COLORS[decision]}>{DECISION_LABELS[decision]}</Tag>
					</Tooltip>
				);
			},
			sorter: (a, b) => (a.result?.evaluation_decision ?? "").localeCompare(b.result?.evaluation_decision ?? ""),
		},
		{
			title: "Georeferencing",
			key: "georef",
			width: 150,
			render: (_, row) => (row.result?.georef_status ? <span className="text-xs">{georefText(row.result)}</span> : NONE),
			sorter: (a, b) => numberOr(a.result?.georef_offset_m) - numberOr(b.result?.georef_offset_m),
		},
		{
			title: "Date",
			key: "date-replace",
			width: 110,
			render: (_, row) =>
				row.result?.date_replace == null ? NONE : row.result.date_replace ? (
					<Tooltip title="AerialStamp would replace the reported date">
						<Tag color="gold">→ {row.result.date_new ? formatIsoDate(row.result.date_new) : "replace"}</Tag>
					</Tooltip>
				) : (
					<span className="text-xs">Keep</span>
				),
		},
		{
			title: "Phenology",
			key: "phenology",
			width: 110,
			render: (_, row) => {
				const p = row.result?.phenology_probability;
				return p == null ? NONE : <Tag color={p >= 0.7 ? "green" : p >= 0.4 ? "gold" : "red"}>{Math.round(p * 100)}%</Tag>;
			},
			sorter: (a, b) => numberOr(a.result?.phenology_probability) - numberOr(b.result?.phenology_probability),
		},
		{ title: "Tree cover major", key: "forest", width: 120, render: (_, row) => <LayerCell row={row} layer="forest_cover" />, sorter: (a, b) => layerShare(a, "forest_cover") - layerShare(b, "forest_cover") },
		{ title: "Deadwood major", key: "deadwood", width: 120, render: (_, row) => <LayerCell row={row} layer="deadwood" />, sorter: (a, b) => layerShare(a, "deadwood") - layerShare(b, "deadwood") },
		{
			title: "Review reason",
			key: "review",
			width: 200,
			render: (_, row) => {
				const items = row.result?.review_required ?? [];
				return (
					<span className="flex flex-wrap gap-1">
						{items.map((item) => (
							<Tag key={item} color="orange" className="m-0">
								{REVIEW_ITEM_LABELS[item]}
							</Tag>
						))}
						{!items.length && NONE}
					</span>
				);
			},
			sorter: (a, b) => (a.result?.review_required.length ?? 0) - (b.result?.review_required.length ?? 0),
		},
	];
	if (tab === "edits-flags") {
		columns.push({
			title: "Reports",
			key: "reports",
			width: 80,
			render: (_, row) =>
				row.flags + row.edits ? (
					<Tooltip title={`${row.flags} user report(s), ${row.edits} suggested edit(s)`}>
						<Badge count={row.flags + row.edits} size="small" />
					</Tooltip>
				) : null,
			sorter: (a, b) => a.flags + a.edits - (b.flags + b.edits),
		});
	}
	if (onReferencePatches) {
		columns.push({
			title: "Reference patches",
			key: "reference_patches",
			width: 150,
			render: (_, row) => (
				<Button size="small" onClick={() => onReferencePatches(row.id)}>
					{row.dataset.has_ml_tiles ? "Continue patches" : "Generate patches"}
				</Button>
			),
		});
	}
	columns.push({
		title: "",
		key: "actions",
		width: 90,
		fixed: "right",
		render: (_, row) => (
			<Button type="primary" size="small" onClick={() => onOpen(row.id)}>
				Open
			</Button>
		),
	});
	return columns;
}
