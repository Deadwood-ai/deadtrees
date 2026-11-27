import { Badge, Button, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { isSortable, type AuditListTab, type IAuditListRow, type IListSort } from "../../../utils/auditReviewList";
import { processingColumns } from "./processingColumns";
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

const location = (row: IAuditListRow) => [row.admin_level_3, row.admin_level_1].filter(Boolean).join(", ") || "Unknown";

function acquisitionDate(row: IAuditListRow): string {
	const { aquisition_year: y, aquisition_month: m, aquisition_day: d } = row;
	if (!y) return "Unknown";
	return [y, m, d].filter(Boolean).map((part, i) => (i ? String(part).padStart(2, "0") : String(part))).join("-");
}

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

/** The table's columns: the same in every tab; Edits & flags adds the count of user reports and
 * edits, the segmentation benchmark the patch editor, the switch the processing stages. The
 * server sorts (utils/auditReviewList listOrder); `sort` marks the sorted column. */
export function auditListColumns({
	tab,
	sort,
	showStages,
	onOpen,
	onReferencePatches,
}: {
	tab: AuditListTab;
	sort: IListSort;
	showStages: boolean;
	onOpen: (id: number) => void;
	/** the reference tab: open the reference patch editor */
	onReferencePatches?: (id: number) => void;
}): ColumnsType<IAuditListRow> {
	const columns: ColumnsType<IAuditListRow> = [
		{ title: "ID", dataIndex: "dataset_id", key: "id", width: 80 },
		{
			title: "Location",
			key: "location",
			width: 170,
			render: (_, row) => <span className="text-sm">{location(row)}</span>,
		},
		{
			title: "Acquired",
			key: "date",
			width: 100,
			render: (_, row) => <span className="font-mono text-xs">{acquisitionDate(row)}</span>,
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
		},
		{
			title: "Georeferencing",
			key: "georef",
			width: 150,
			render: (_, row) => (row.result?.georef_status ? <span className="text-xs">{georefText(row.result)}</span> : NONE),
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
		},
		{ title: "Tree cover major", key: "forest", width: 120, render: (_, row) => <LayerCell row={row} layer="forest_cover" /> },
		{ title: "Deadwood major", key: "deadwood", width: 120, render: (_, row) => <LayerCell row={row} layer="deadwood" /> },
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
		});
	}
	if (showStages) columns.push(processingColumns());
	if (onReferencePatches) {
		columns.push({
			title: "Reference patches",
			key: "reference_patches",
			width: 150,
			render: (_, row) => (
				<Button size="small" onClick={() => onReferencePatches(row.dataset_id)}>
					{row.has_ml_tiles ? "Continue patches" : "Generate patches"}
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
			<Button type="primary" size="small" onClick={() => onOpen(row.dataset_id)}>
				Open
			</Button>
		),
	});
	// the server sorts: each sortable column says whether it is the sorted one
	return columns.map((column) =>
		column.key && isSortable(String(column.key))
			? { ...column, sorter: true, sortOrder: column.key === sort.key ? (sort.ascending ? "ascend" : "descend") : null }
			: column,
	);
}
