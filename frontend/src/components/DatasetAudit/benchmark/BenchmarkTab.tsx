import { Link, useNavigate } from "react-router-dom";
import { Button, Spin, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { BENCHMARKS, useBenchmark, useOpenBenchmarks } from "../../../hooks/useAuditBenchmarks";
import { useCanOperate } from "../../../hooks/useUserPrivileges";
import type { AuditVerdict, IAuditBenchmark, IBenchmarkTarget } from "../../../types/auditChecks";
import { evaluationAnswerText } from "../../../utils/auditChecks";
import { cantTell } from "../../../utils/cropAnswers";
import { MODE_LABELS } from "../../../utils/cropCalls";
import { isLabeled, latestLabelRow, sameBenchmark, targetKey, targetNoun } from "../../../utils/benchmarkLabels";

const VERDICT_TAG: Record<AuditVerdict, { color: string; label: string }> = {
	ok: { color: "green", label: "OK" },
	minor: { color: "gold", label: "Minor" },
	major: { color: "red", label: "Major" },
	ambiguous: { color: "purple", label: "Ambiguous" },
	unsure: { color: "default", label: "Unsure" },
};

const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");

/** The Benchmark tab of the audit: per benchmark (prediction quality has one per layer) its open
 * version, Label new random tiles or datasets (operators; each joins with its label), Review
 * existing labels, and the table of its labels. */
export default function BenchmarkTab() {
	const { data: open, isLoading, isError } = useOpenBenchmarks();
	if (isLoading) return <Spin />;
	if (isError) return <div className="text-sm text-red-600">The benchmarks couldn’t load. The audit tables may not be reachable on this server yet.</div>;
	return (
		<div className="flex flex-col gap-8">
			{BENCHMARKS.map((definition) => (
				<BenchmarkSection key={definition.key} id={definition.key} title={definition.title} benchmark={open?.find((b) => sameBenchmark(b, definition))} />
			))}
		</div>
	);
}

function BenchmarkSection({ id, title, benchmark }: { id: string; title: string; benchmark: IAuditBenchmark | undefined }) {
	const navigate = useNavigate();
	const { canOperate } = useCanOperate();
	const { data, isLoading } = useBenchmark(benchmark);
	const labeled = (data?.targets ?? []).filter(isLabeled);
	const unlabeled = (data?.targets.length ?? 0) - labeled.length;
	const to = (mode: "new" | "review", target?: IBenchmarkTarget) =>
		`/dataset-audit/benchmark/${id}?mode=${mode}${target ? `&target=${targetKey(target)}` : ""}`;
	return (
		<section className="flex flex-col gap-3" data-testid={`benchmark-card-${id}`}>
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
				<h3 className="m-0 text-base font-semibold">{title}</h3>
				{benchmark && (
					<span className="text-xs text-gray-500">
						{benchmark.name} {benchmark.version}
					</span>
				)}
			</div>
			{!benchmark ? (
				<div className="text-sm text-gray-500">No open version.</div>
			) : (
				<>
					<div className="flex flex-wrap items-center gap-3">
						<span className="text-sm">
							<b data-testid={`benchmark-count-${id}`}>{labeled.length}</b> labeled {targetNoun(benchmark, labeled.length)}
						</span>
						<Tooltip title={canOperate ? `Random ${targetNoun(benchmark)} not in the benchmark yet; each joins it with your label` : "Adding to a benchmark is for operators"}>
							<Button type="primary" disabled={!canOperate} onClick={() => navigate(to("new"))}>
								Label new random {targetNoun(benchmark)}
							</Button>
						</Tooltip>
						<Button disabled={!labeled.length} onClick={() => navigate(to("review"))}>
							Review existing labels
						</Button>
						{unlabeled > 0 && (
							<span className="text-xs text-gray-500" data-testid={`benchmark-unlabeled-${id}`}>
								{unlabeled} {targetNoun(benchmark, unlabeled)} added earlier without a label: not shown and not scored
							</span>
						)}
					</div>
					<Table<IBenchmarkTarget>
						dataSource={labeled}
						columns={benchmark.layer ? cropColumns(benchmark.layer, (t) => navigate(to("review", t))) : datasetColumns((t) => navigate(to("review", t)))}
						rowKey={(t) => targetKey(t)}
						size="small"
						loading={isLoading}
						pagination={{ pageSize: 10, hideOnSinglePage: true }}
						locale={{ emptyText: `No labeled ${targetNoun(benchmark)} yet` }}
						data-testid={`benchmark-table-${id}`}
					/>
				</>
			)}
		</section>
	);
}

const datasetLink = (t: IBenchmarkTarget) => (
	<Link to={`/dataset/${t.dataset_id}`} target="_blank">
		{t.dataset_id}
	</Link>
);

/** Who gave the label and when, and the member's side. */
const PROVENANCE: ColumnsType<IBenchmarkTarget> = [
	{ title: "Labeled by", key: "by", render: (_, t) => (latestLabelRow(t)?.assessor_email ?? "–").split("@")[0] },
	{
		title: "Labeled",
		key: "at",
		render: (_, t) => when(latestLabelRow(t)?.created_at),
		sorter: (a, b) => (latestLabelRow(a)?.id ?? 0) - (latestLabelRow(b)?.id ?? 0),
		defaultSortOrder: "descend",
	},
	{ title: "Split", dataIndex: "split", key: "split", render: (split: string | null) => split ?? "–" },
];

const openColumn = (onOpen: (t: IBenchmarkTarget) => void): ColumnsType<IBenchmarkTarget>[number] => ({
	key: "open",
	width: 80,
	render: (_, t) => (
		<Button size="small" onClick={() => onOpen(t)}>
			Open
		</Button>
	),
});

/** A tile benchmark's labels: the layer's verdict on the tile with the failure modes seen, or
 * "can't tell what it shows". */
function cropColumns(layer: string, onOpen: (t: IBenchmarkTarget) => void): ColumnsType<IBenchmarkTarget> {
	return [
		{ title: "Dataset", key: "dataset", render: (_, t) => datasetLink(t), sorter: (a, b) => a.dataset_id - b.dataset_id },
		{ title: "Tile", dataIndex: "crop_id", key: "tile" },
		{
			title: "Label",
			key: "label",
			render: (_, t) => {
				if (cantTell(t.people.find((p) => p.layer === "image"))) return <Tag className="m-0">Can't tell what it shows</Tag>;
				const row = t.people.find((p) => p.layer === layer);
				if (!row?.verdict) return "–";
				const seen = Object.entries(row.modes ?? {})
					.filter(([, tag]) => tag === true)
					.map(([mode]) => MODE_LABELS[mode] ?? mode);
				return (
					<span className="flex flex-wrap items-center gap-1.5">
						<Tag color={VERDICT_TAG[row.verdict].color} className="m-0">
							{VERDICT_TAG[row.verdict].label}
						</Tag>
						{seen.length > 0 && <span className="text-xs text-gray-600">{seen.join(", ")}</span>}
					</span>
				);
			},
		},
		...PROVENANCE,
		openColumn(onOpen),
	];
}

/** The dataset evaluation benchmark's labels: OK (with its issues) or exclude with the reason,
 * and the note. */
function datasetColumns(onOpen: (t: IBenchmarkTarget) => void): ColumnsType<IBenchmarkTarget> {
	return [
		{ title: "Dataset", key: "dataset", render: (_, t) => datasetLink(t), sorter: (a, b) => a.dataset_id - b.dataset_id },
		{
			title: "Label",
			key: "label",
			render: (_, t) => {
				const row = latestLabelRow(t);
				if (!row) return "–";
				const text = evaluationAnswerText(row);
				return (
					<Tag color={text.startsWith("Exclude") ? "red" : text === "Unsure" ? "default" : "green"} className="m-0">
						{text}
					</Tag>
				);
			},
		},
		{ title: "Note", key: "note", render: (_, t) => <span className="text-xs text-gray-600">{latestLabelRow(t)?.reason_text ?? ""}</span> },
		...PROVENANCE,
		openColumn(onOpen),
	];
}
