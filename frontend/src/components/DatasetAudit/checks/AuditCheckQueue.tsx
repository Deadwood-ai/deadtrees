import { CheckCircleOutlined } from "@ant-design/icons";
import { useState } from "react";
import { Button, Checkbox, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link } from "react-router-dom";
import { reviewKey, useAuditCheckQueue, type AuditCheckQueueKind, type IAuditDisagreement } from "../../../hooks/useAuditCheckQueue";
import type { AuditCheckKey, AuditVerdict, IAuditQueueRow } from "../../../types/auditChecks";
import { LAYER_LABELS, VERDICT_TONE, auditSection, sectionOfCheck, verdictLabel } from "../../../utils/auditChecks";
import EmptyStatePanel from "../../EmptyStatePanel";
import { SectionLoadError, TableSkeleton } from "../../SectionStates";

interface AuditCheckQueueProps {
	kind: AuditCheckQueueKind;
	/** the dataset's location, from the list the page already holds */
	locationOf: (datasetId: number) => string;
}

const TAG_COLORS = { ok: "green", warn: "gold", bad: "red", todo: "default" } as const;
const WHY: Record<NonNullable<IAuditQueueRow["reason"]>, string> = {
	review_all: "Review all: new check",
	unsure: "Check unsure",
	models_disagree: "Models disagree",
	spot_check: "Spot check",
};

const checkName = (checkKey: AuditCheckKey, layer: string) =>
	`${auditSection(sectionOfCheck(checkKey)).title}${LAYER_LABELS[layer as keyof typeof LAYER_LABELS] ? ` · ${LAYER_LABELS[layer as keyof typeof LAYER_LABELS]}` : ""}`;
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

/** The automated check results waiting for a person, or their disagreements: one row per
 * check result, not per dataset. */
export default function AuditCheckQueue({ kind, locationOf }: AuditCheckQueueProps) {
	const { data, isLoading, isError, refetch } = useAuditCheckQueue(true);
	const [onlyMine, setOnlyMine] = useState(true);
	if (isLoading) return <TableSkeleton label="Loading check results" />;
	if (isError) return <SectionLoadError title="Check results couldn’t load" onRetry={() => refetch()} />;
	if (!data?.available) {
		return <EmptyStatePanel icon={<CheckCircleOutlined />} title="Check results aren’t reachable yet" description="The automated audit checks are not exposed to the app on this server yet." />;
	}

	const base = {
		id: { title: "ID", dataIndex: "dataset_id", key: "id", width: 80 },
		location: { title: "Location", key: "location", render: (_: unknown, r: { dataset_id: number }) => locationOf(r.dataset_id), width: 180 },
	};

	if (kind === "to-review") {
		const columns: ColumnsType<IAuditQueueRow> = [
			base.id,
			base.location,
			{ title: "Check", key: "check", render: (_, r) => checkName(r.check_key, r.layer) },
			{ title: "Automated result", key: "result", render: (_, r) => verdictTag(r.check_key, r.verdict) },
			{ title: "Why it needs a person", key: "why", render: (_, r) => (r.reason ? WHY[r.reason] : "") },
			{ title: "Reviews", key: "reviews", render: (_, r) => data.reviews[reviewKey(r)]?.count ?? 0, width: 90 },
			{ title: "", key: "action", render: (_, r) => reviewLink(r.dataset_id, r.check_key), width: 100 },
		];
		const rows = onlyMine ? data.toReview.filter((r) => !data.reviews[reviewKey(r)]?.mine) : data.toReview;
		return (
			<>
				<Checkbox className="mb-3" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)}>
					Only results I haven't answered
				</Checkbox>
				{rows.length ? (
					<Table dataSource={rows} columns={columns} rowKey={reviewKey} pagination={{ pageSize: 20 }} scroll={{ x: 900 }} />
				) : (
					<EmptyStatePanel icon={<CheckCircleOutlined />} title="Nothing to review" description="No check result is waiting for you." />
				)}
			</>
		);
	}

	const columns: ColumnsType<IAuditDisagreement> = [
		base.id,
		base.location,
		{ title: "Check", key: "check", render: (_, r) => checkName(r.check_key, r.layer) },
		{
			title: "Answers",
			key: "answers",
			render: (_, r) => (
				<span className="flex flex-wrap gap-1">{[...new Set(Object.values(r.verdicts))].map((v) => <span key={v}>{verdictTag(r.check_key, v)}</span>)}</span>
			),
		},
		{ title: "Disagreement", key: "why", render: (_, r) => disagreementWhy(r) },
		{ title: "", key: "action", render: (_, r) => reviewLink(r.dataset_id, r.check_key), width: 100 },
	];
	return data.disagreements.length ? (
		<Table
			dataSource={data.disagreements}
			columns={columns}
			rowKey={(r) => `${reviewKey(r)}:${r.crop_id ?? "dataset"}`}
			pagination={{ pageSize: 20 }}
			scroll={{ x: 900 }}
		/>
	) : (
		<EmptyStatePanel icon={<CheckCircleOutlined />} title="No disagreements" description="Reviewers and models agree on every answered check." />
	);
}
