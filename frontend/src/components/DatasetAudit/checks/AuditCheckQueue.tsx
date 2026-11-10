import { useState, type ReactNode } from "react";
import { CheckCircleOutlined } from "@ant-design/icons";
import { Alert, Button, Checkbox, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link } from "react-router-dom";
import { reviewKey, useAuditDisagreements, useAuditReviewList, type IAuditDisagreement } from "../../../hooks/useAuditCheckQueue";
import type { AuditCheckKey, AuditLayer, AuditVerdict, IAuditQueueRow } from "../../../types/auditChecks";
import { LAYER_LABELS, QUEUE_REASONS, VERDICT_TONE, auditSection, sectionOfCheck, verdictLabel } from "../../../utils/auditChecks";
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
const reviewLink = (datasetId: number, checkKey: AuditCheckKey) => (
	<Link to={`/dataset-audit/${datasetId}?section=${sectionOfCheck(checkKey)}`}>
		<Button type="primary" size="small">
			Review
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
	const [onlyMine, setOnlyMine] = useState(true);
	const reviews = list.data?.reviews ?? {};
	const all = list.data?.rows ?? [];
	const rows = onlyMine ? all.filter((r) => !reviews[reviewKey(r)]?.mine) : all;
	const columns: ColumnsType<IAuditQueueRow> = [
		idColumn,
		{ title: "Location", key: "location", render: (_, r) => locationOf(r.dataset_id), width: 180 },
		{ title: "Check", key: "check", render: (_, r) => checkName(r.check_key, r.layer) },
		{ title: "Automated result", key: "result", render: (_, r) => verdictTag(r.check_key, r.verdict) },
		{ title: "Why it needs a person", key: "why", render: (_, r) => (r.reason ? QUEUE_REASONS[r.reason].label : "") },
		{ title: "Reviews", key: "reviews", render: (_, r) => reviews[reviewKey(r)]?.count ?? 0, width: 90 },
		{ title: "", key: "action", render: (_, r) => reviewLink(r.dataset_id, r.check_key), width: 100 },
	];
	return (
		<ListFrame list={list}>
			<Checkbox className="mb-3" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)}>
				Only results I haven't answered
			</Checkbox>
			{rows.length ? (
				<Table dataSource={rows} columns={columns} rowKey={reviewKey} pagination={{ pageSize: 20 }} scroll={{ x: 900 }} />
			) : (
				<EmptyStatePanel
					icon={<CheckCircleOutlined />}
					title="Nothing to review"
					description={
						all.length < (list.data?.total ?? 0)
							? "You answered every result this list can show. More are waiting, but cannot be listed here yet."
							: "No check result is waiting for you."
					}
				/>
			)}
		</ListFrame>
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

/** The automated check results under review, or their disagreements: one row per check
 * result, not per dataset. */
export default function AuditCheckQueue({ kind, locationOf }: AuditCheckQueueProps) {
	return kind === "to-review" ? <ToReviewList locationOf={locationOf} /> : <DisagreementList locationOf={locationOf} />;
}
