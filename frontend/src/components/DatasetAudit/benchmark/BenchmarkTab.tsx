import { Link, useNavigate } from "react-router-dom";
import { Button, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useBenchmark } from "../../../hooks/useAuditBenchmarks";
import { useCanOperate } from "../../../hooks/useUserPrivileges";
import type { AuditVerdict } from "../../../types/auditChecks";
import { VERDICT_WORD, evaluationAnswerText } from "../../../utils/auditChecks";
import { MODE_LABELS } from "../../../utils/tileFindings";
import { BENCHMARKS, targetKey, targetNoun, type BenchmarkKey, type IBenchmarkTarget, type IDatasetTarget, type ITileTarget } from "../../../utils/benchmarkLabels";
import { SectionLoadError } from "../../SectionStates";

const VERDICT_COLOR: Record<AuditVerdict, string> = { ok: "green", minor: "gold", major: "red", ambiguous: "purple", not_assessable: "default" };

const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");

/** The Benchmark tab of the audit: per benchmark (prediction quality has one per layer) Label new
 * random tiles or datasets (operators; each joins with its label), Review existing labels, and
 * the table of its labels. */
export default function BenchmarkTab() {
	return (
		<div className="flex flex-col gap-8">
			{BENCHMARKS.map((b) => (
				<BenchmarkSection key={b.key} id={b.key} title={b.title} tiles={!!b.layer} />
			))}
		</div>
	);
}

function BenchmarkSection({ id, title, tiles }: { id: BenchmarkKey; title: string; tiles: boolean }) {
	const navigate = useNavigate();
	const { canOperate } = useCanOperate();
	const { data: labeled = [], isLoading, isError, refetch } = useBenchmark(id);
	const noun = targetNoun(tiles);
	const to = (mode: "new" | "review", target?: IBenchmarkTarget) => `/dataset-audit/benchmark/${id}?mode=${mode}${target ? `&target=${targetKey(target)}` : ""}`;
	const open = (t: IBenchmarkTarget) => navigate(to("review", t));
	return (
		<section className="flex flex-col gap-3" data-testid={`benchmark-card-${id}`}>
			<h3 className="m-0 text-base font-semibold">{title}</h3>
			<div className="flex flex-wrap items-center gap-3">
				<span className="text-sm">
					<b data-testid={`benchmark-count-${id}`}>{labeled.length}</b> labeled {targetNoun(tiles, labeled.length)}
				</span>
				<Tooltip title={canOperate ? `Random ${noun} not in the benchmark yet; each joins it with your label` : "Adding to a benchmark is for operators"}>
					<Button type="primary" disabled={!canOperate} onClick={() => navigate(to("new"))}>
						Label new random {noun}
					</Button>
				</Tooltip>
				<Button disabled={!labeled.length} onClick={() => navigate(to("review"))}>
					Review existing labels
				</Button>
			</div>
			{isError ? (
				<SectionLoadError title={`The ${title.toLowerCase()} benchmark couldn’t load`} onRetry={() => void refetch()} />
			) : (
				<Table<IBenchmarkTarget>
					dataSource={labeled}
					columns={tiles ? (tileColumns(open) as ColumnsType<IBenchmarkTarget>) : (datasetColumns(open) as ColumnsType<IBenchmarkTarget>)}
					rowKey={(t) => targetKey(t)}
					size="small"
					loading={isLoading}
					pagination={{ pageSize: 10, hideOnSinglePage: true }}
					locale={{ emptyText: `No labeled ${noun} yet` }}
					data-testid={`benchmark-table-${id}`}
				/>
			)}
		</section>
	);
}

const datasetLink = (t: IBenchmarkTarget) => (
	<Link to={`/dataset/${t.dataset_id}`} target="_blank">
		{t.dataset_id}
	</Link>
);

/** Who gave the label and when. */
function provenance<T extends IBenchmarkTarget>(): ColumnsType<T> {
	return [
		{ title: "Labeled by", key: "by", render: (_, t) => (t.label?.reviewer_email ?? "–").split("@")[0] },
		{
			title: "Labeled",
			key: "at",
			render: (_, t) => when(t.label?.created_at),
			sorter: (a, b) => (a.label?.id ?? 0) - (b.label?.id ?? 0),
			defaultSortOrder: "descend",
		},
	];
}

function openColumn<T extends IBenchmarkTarget>(onOpen: (t: T) => void): ColumnsType<T>[number] {
	return {
		key: "open",
		width: 80,
		render: (_, t) => (
			<Button size="small" onClick={() => onOpen(t)}>
				Open
			</Button>
		),
	};
}

/** A tile benchmark's labels: the layer's verdict on the tile with the failure modes seen. */
function tileColumns(onOpen: (t: ITileTarget) => void): ColumnsType<ITileTarget> {
	return [
		{ title: "Dataset", key: "dataset", render: (_, t) => datasetLink(t), sorter: (a, b) => a.dataset_id - b.dataset_id },
		{ title: "Tile", dataIndex: "tile_id", key: "tile" },
		{
			title: "Label",
			key: "label",
			render: (_, t) => {
				if (!t.label) return "–";
				const seen = Object.entries(t.label.problems ?? {})
					.filter(([, tag]) => tag === true)
					.map(([mode]) => MODE_LABELS[mode] ?? mode);
				return (
					<span className="flex flex-wrap items-center gap-1.5">
						<Tag color={VERDICT_COLOR[t.label.verdict]} className="m-0">
							{t.label.verdict === "not_assessable" ? "Can't tell what it shows" : VERDICT_WORD[t.label.verdict]}
						</Tag>
						{seen.length > 0 && <span className="text-xs text-gray-600">{seen.join(", ")}</span>}
					</span>
				);
			},
		},
		...provenance<ITileTarget>(),
		openColumn(onOpen),
	];
}

/** The dataset evaluation benchmark's labels: OK (with its issues) or exclude with the reason, and the note. */
function datasetColumns(onOpen: (t: IDatasetTarget) => void): ColumnsType<IDatasetTarget> {
	return [
		{ title: "Dataset", key: "dataset", render: (_, t) => datasetLink(t), sorter: (a, b) => a.dataset_id - b.dataset_id },
		{
			title: "Label",
			key: "label",
			render: (_, t) =>
				t.label ? (
					<Tag color={t.label.decision === "exclude" ? "red" : "green"} className="m-0">
						{evaluationAnswerText(t.label)}
					</Tag>
				) : (
					"–"
				),
		},
		{ title: "Note", key: "note", render: (_, t) => <span className="text-xs text-gray-600">{t.label?.note ?? ""}</span> },
		...provenance<IDatasetTarget>(),
		openColumn(onOpen),
	];
}
