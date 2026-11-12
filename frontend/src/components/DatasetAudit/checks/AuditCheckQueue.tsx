import { useState, type ReactNode } from "react";
import { CheckCircleOutlined } from "@ant-design/icons";
import { Alert, Button, Checkbox, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link } from "react-router-dom";
import { useAuditDisagreements, useAuditReviewList, type IAuditDisagreement } from "../../../hooks/useAuditCheckQueue";
import type { AuditCheckKey, AuditLayer, AuditVerdict } from "../../../types/auditChecks";
import { LAYER_LABELS, VERDICT_TONE, auditSection, sectionOfCheck, verdictLabel } from "../../../utils/auditChecks";
import {
	datasetReviewRows,
	reviewHref,
	reviewKey,
	reviewTargets,
	type IDatasetReviewRow,
	type IReviewCell,
} from "../../../utils/auditReviewList";
import EmptyStatePanel from "../../EmptyStatePanel";
import { SectionLoadError, TableSkeleton } from "../../SectionStates";

export type AuditCheckQueueKind = "to-review" | "disagreements";

interface AuditCheckQueueProps {
	kind: AuditCheckQueueKind;
	/** the dataset's location, from the list the page already holds */
	locationOf: (datasetId: number) => string;
}

const TAG_COLORS = { ok: "green", warn: "gold", bad: "red", todo: "default" } as const;

const checkName = (checkKey: AuditCheckKey, layer: AuditLayer) =>
	`${auditSection(sectionOfCheck(checkKey)).title}${LAYER_LABELS[layer] ? ` · ${LAYER_LABELS[layer]}` : ""}`;
const verdictTag = (checkKey: AuditCheckKey, verdict: AuditVerdict) => (
	<Tag color={TAG_COLORS[VERDICT_TONE[verdict]]}>{verdictLabel(checkKey, verdict)}</Tag>
);
const reviewLink = (datasetId: number, checkKey: AuditCheckKey, finished = false) => (
	<Link to={reviewHref(datasetId, checkKey)}>
		<Button type={finished ? "default" : "primary"} size="small">
			{finished ? "Open" : "Review"}
		</Button>
	</Link>
);

function disagreementWhy(d: IAuditDisagreement) {
	const kinds = [
		d.people_disagree && "reviewers disagree",
		d.people_and_models_disagree && "reviewers and models disagree",
		d.legacy_and_models_disagree && "the old audit and the models disagree",
	].filter(Boolean);
	return `${d.crop_id === null ? "Dataset" : `Crop ${d.crop_id}`}: ${kinds.join(", ")}`;
}

interface IListState {
	isLoading: boolean;
	isError: boolean;
	refetch: () => unknown;
	data: { available: boolean; rows: unknown[]; total: number } | undefined;
}

/** Loading, failed and unreachable states shared by both lists, and a notice when the server cut the list. */
function ListFrame({ list, children }: { list: IListState; children: ReactNode }) {
	if (list.isLoading) return <TableSkeleton label="Loading check results" />;
	if (list.isError) return <SectionLoadError title="Check results couldn’t load" onRetry={() => void list.refetch()} />;
	if (!list.data?.available) {
		return (
			<EmptyStatePanel
				icon={<CheckCircleOutlined />}
				title="Check results aren’t reachable yet"
				description="The automated audit checks are not exposed to the app on this server yet."
			/>
		);
	}
	const { rows, total } = list.data;
	return (
		<>
			{total > rows.length && (
				<Alert
					type="info"
					showIcon
					className="mb-3"
					message={`Showing ${rows.length} of ${total} results, newest datasets first. The others cannot be listed here yet.`}
				/>
			)}
			{children}
		</>
	);
}

const idColumn = { title: "ID", dataIndex: "dataset_id", key: "id", width: 80 };

function ToReviewList({ locationOf }: Pick<AuditCheckQueueProps, "locationOf">) {
	const list = useAuditReviewList();
	const [onlyComplete, setOnlyComplete] = useState(true);
	const [onlyOpen, setOnlyOpen] = useState(true);
	const queue = list.data?.rows ?? [];
	const targets = reviewTargets(queue);
	const all = datasetReviewRows(queue, list.data?.reviews ?? {}, targets);
	const waiting = all.filter((r) => !r.complete).length;
	const rows = all.filter((r) => (!onlyComplete || r.complete) && (!onlyOpen || !r.finished));
	const columns: ColumnsType<IDatasetReviewRow> = [
		{ title: "ID", dataIndex: "datasetId", key: "id", width: 80, sorter: (a, b) => a.datasetId - b.datasetId },
		{ title: "Location", key: "location", render: (_, r) => locationOf(r.datasetId), width: 170 },
		...targets.map((t) => ({
			title: t.title,
			key: t.key,
			render: (_: unknown, r: IDatasetReviewRow) => <ResultCell checkKey={t.checkKey} cell={r.cells[t.key]} />,
		})),
		{
			title: "Problems",
			key: "problems",
			width: 100,
			render: (_, r) => r.problems || "",
			sorter: (a, b) => a.problems - b.problems,
		},
		{
			title: "",
			key: "action",
			width: 100,
			render: (_, r) => reviewLink(r.datasetId, r.next, r.finished),
		},
	];
	return (
		<ListFrame list={list}>
			<div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1">
				<Checkbox checked={onlyComplete} onChange={(e) => setOnlyComplete(e.target.checked)}>
					Only datasets where every check ran
				</Checkbox>
				<Checkbox checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)}>
					Only datasets I haven't finished
				</Checkbox>
				<span className="text-xs text-gray-500" data-testid="audit-review-count">
					{rows.length} of {all.length} datasets{waiting ? ` · ${waiting} still wait for a check to run` : ""}
				</span>
			</div>
			{rows.length ? (
				<Table
					dataSource={rows}
					columns={columns}
					rowKey="datasetId"
					pagination={{ pageSize: 20, showSizeChanger: false }}
					scroll={{ x: 900 }}
				/>
			) : (
				<EmptyStatePanel
					icon={<CheckCircleOutlined />}
					title="Nothing to review"
					description={
						onlyComplete && waiting
							? `No dataset with every check done is waiting for you. ${waiting} datasets still wait for a check to run.`
							: "No check result is waiting for you."
					}
				/>
			)}
		</ListFrame>
	);
}

/** A check's result in the list: its verdict, a mark when you answered it, or "Not run". */
function ResultCell({ checkKey, cell }: { checkKey: AuditCheckKey; cell: IReviewCell | undefined }) {
	if (!cell) return <span className="text-xs text-gray-400">Not run</span>;
	return (
		<span className="inline-flex items-center gap-1 whitespace-nowrap">
			<span className={cell.needsReview ? "" : "opacity-60"} title={cell.needsReview ? undefined : "Applied without review"}>
				{verdictTag(checkKey, cell.verdict)}
			</span>
			{cell.mine && (
				<span className="text-xs text-green-700" title="You answered this result">
					✓ you
				</span>
			)}
		</span>
	);
}

function DisagreementList({ locationOf }: Pick<AuditCheckQueueProps, "locationOf">) {
	const list = useAuditDisagreements();
	const rows = list.data?.rows ?? [];
	const columns: ColumnsType<IAuditDisagreement> = [
		idColumn,
		{ title: "Location", key: "location", render: (_, r) => locationOf(r.dataset_id), width: 180 },
		{ title: "Check", key: "check", render: (_, r) => checkName(r.check_key, r.layer) },
		{
			title: "Answers",
			key: "answers",
			render: (_, r) => (
				<span className="flex flex-wrap gap-1">
					{[...new Set(Object.values(r.verdicts))].map((v) => (
						<span key={v}>{verdictTag(r.check_key, v)}</span>
					))}
				</span>
			),
		},
		{ title: "Disagreement", key: "why", render: (_, r) => disagreementWhy(r) },
		{ title: "", key: "action", render: (_, r) => reviewLink(r.dataset_id, r.check_key), width: 100 },
	];
	return (
		<ListFrame list={list}>
			{rows.length ? (
				<Table
					dataSource={rows}
					columns={columns}
					rowKey={(r) => `${reviewKey(r)}:${r.crop_id ?? "dataset"}`}
					pagination={{ pageSize: 20 }}
					scroll={{ x: 900 }}
				/>
			) : (
				<EmptyStatePanel icon={<CheckCircleOutlined />} title="No disagreements" description="Reviewers and models agree on every answered check." />
			)}
		</ListFrame>
	);
}

/** The automated check results under review, one row per dataset with a column per check,
 * or their disagreements, one row per check result. */
export default function AuditCheckQueue({ kind, locationOf }: AuditCheckQueueProps) {
	return kind === "to-review" ? <ToReviewList locationOf={locationOf} /> : <DisagreementList locationOf={locationOf} />;
}
