import { Table, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { formatUtc, truncate } from "./factoryFormat";
import { EmptyNote } from "./FactoryPrimitives";
import type { FactoryRecord } from "./factoryTypes";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export function humanizeKey(key: string): string {
	const text = key.replace(/^is_/, "").replace(/_/g, " ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Binary units, so 536870912 reads as 512 MiB and 1 GiB matches the ledger's size classes. */
function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let size = value / 1024;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit += 1;
	}
	return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatRecordValue(key: string, value: unknown): string {
	if (value === null || value === undefined || value === "") return "—";
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (typeof value === "number") {
		if (/size_mb$/.test(key)) return `${value.toLocaleString()} MB`;
		if (/size|bytes/.test(key)) return formatBytes(value);
		if (/runtime/.test(key)) return `${value.toLocaleString()} s`;
		return value.toLocaleString();
	}
	if (typeof value === "string") {
		if (/_at$|_date$/.test(key) || ISO_DATE.test(value)) return formatUtc(value);
		return value;
	}
	if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : "none";
	return JSON.stringify(value);
}

type FactoryRecordTableProps = {
	records: FactoryRecord[];
	emptyText: string;
	/** Column order and subset. Defaults to every key that has at least one value. */
	columns?: string[];
	labels?: Record<string, string>;
	rowKey?: string;
	maxTextLength?: number;
	testId?: string;
};

/**
 * Renders arrays of database rows whose exact shape is owned by the SQL side.
 * Columns come from the data, so a new backend field shows up without a
 * frontend change and a removed field simply disappears.
 */
export default function FactoryRecordTable({
	records,
	emptyText,
	columns,
	labels = {},
	rowKey,
	maxTextLength = 160,
	testId,
}: FactoryRecordTableProps) {
	if (records.length === 0) return <EmptyNote>{emptyText}</EmptyNote>;

	const keys =
		columns ??
		Array.from(
			records.reduce((set, record) => {
				Object.keys(record).forEach((key) => {
					const value = record[key];
					if (value !== null && value !== undefined) set.add(key);
				});
				return set;
			}, new Set<string>())
		);

	const tableColumns: ColumnsType<FactoryRecord> = keys.map((key) => ({
		title: labels[key] ?? humanizeKey(key),
		key,
		dataIndex: key,
		ellipsis: true,
		render: (value: unknown) => {
			const text = formatRecordValue(key, value);
			const shown = truncate(text, maxTextLength);
			return shown === text ? (
				<span className="whitespace-pre-wrap text-xs">{text}</span>
			) : (
				<Tooltip title={text}>
					<span className="whitespace-pre-wrap text-xs">{shown}</span>
				</Tooltip>
			);
		},
	}));

	return (
		<Table
			size="small"
			pagination={records.length > 10 ? { pageSize: 10, size: "small", showSizeChanger: false } : false}
			dataSource={records}
			columns={tableColumns}
			rowKey={(record) => (rowKey && record[rowKey] !== undefined ? String(record[rowKey]) : JSON.stringify(record))}
			scroll={{ x: true }}
			data-testid={testId}
		/>
	);
}
