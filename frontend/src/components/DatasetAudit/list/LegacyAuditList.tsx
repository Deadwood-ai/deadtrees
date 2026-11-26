import { Link } from "react-router-dom";
import { Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useLegacyDatasetAudits, type DatasetAuditUserInfo } from "../../../hooks/useDatasetAudit";
import { SectionLoadError, TableSkeleton } from "../../SectionStates";

// Old values ("ready", "no_major_issues") show as stored text.
const ASSESSMENTS: Record<string, { label: string; color: string }> = {
	no_issues: { label: "No issues", color: "green" },
	fixable_issues: { label: "Fixable issues", color: "gold" },
	exclude_completely: { label: "Exclude completely", color: "red" },
};

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
const QUALITY: Record<string, string> = { great: "Great", sentinel_ok: "OK", bad: "Bad" };

const columns: ColumnsType<DatasetAuditUserInfo> = [
	{ title: "ID", dataIndex: "dataset_id", key: "id", width: 80, sorter: (a, b) => a.dataset_id - b.dataset_id, defaultSortOrder: "descend" },
	{
		title: "Final assessment",
		key: "final",
		width: 150,
		render: (_, row) => {
			if (!row.final_assessment) return "—";
			const known = ASSESSMENTS[row.final_assessment];
			return <Tag color={known?.color}>{known?.label ?? row.final_assessment}</Tag>;
		},
		sorter: (a, b) => (a.final_assessment ?? "").localeCompare(b.final_assessment ?? ""),
	},
	{ title: "Audited", key: "date", width: 110, render: (_, row) => day(row.audit_date), sorter: (a, b) => (a.audit_date ?? "").localeCompare(b.audit_date ?? "") },
	{ title: "Auditor", key: "auditor", width: 200, render: (_, row) => row.audited_by_email ?? "—" },
	{ title: "Deadwood", key: "deadwood", width: 90, render: (_, row) => QUALITY[row.deadwood_quality ?? ""] ?? "—" },
	{ title: "Tree cover", key: "forest", width: 90, render: (_, row) => QUALITY[row.forest_cover_quality ?? ""] ?? "—" },
	{
		title: "Notes",
		key: "notes",
		render: (_, row) =>
			row.notes ? (
				<Tooltip title={row.notes}>
					<span className="text-xs text-gray-600">{row.notes.length > 60 ? `${row.notes.slice(0, 60)}…` : row.notes}</span>
				</Tooltip>
			) : (
				"—"
			),
	},
	{ title: "", key: "open", width: 110, render: (_, row) => <Link to={`/dataset/${row.dataset_id}`}>Dataset page</Link> },
];

/** The manual audits saved before the Audit Review (dataset_audit), read-only history: nothing
 * writes them any more and no workflow reads them. The excluded ones live on as imported
 * evaluation decisions. */
export default function LegacyAuditList() {
	const { data, isLoading, isError, refetch } = useLegacyDatasetAudits();
	if (isLoading) return <TableSkeleton label="Loading the legacy audits" />;
	if (isError) return <SectionLoadError title="The legacy audits couldn’t load" onRetry={() => void refetch()} />;
	return (
		<Table
			dataSource={data ?? []}
			columns={columns}
			rowKey="dataset_id"
			size="small"
			pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (total) => `${total} legacy audits` }}
			scroll={{ x: 1000 }}
			data-testid="legacy-audit-list"
		/>
	);
}
