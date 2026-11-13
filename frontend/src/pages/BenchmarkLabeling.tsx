import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Button, Segmented, Spin, message } from "antd";
import { useAuth } from "../hooks/useAuthProvider";
import { useCanAudit } from "../hooks/useUserPrivileges";
import { BENCHMARK_CHECKS, useBenchmark, useOpenBenchmarks, useSaveBenchmarkLabel } from "../hooks/useAuditBenchmarks";
import type { AuditCheckKey, IAuditAnswerInput, IBenchmarkTarget } from "../types/auditChecks";
import { stepCrop } from "../utils/auditChecks";
import { BENCHMARK_FILTERS, answeredBy, filterTargets, nextOpen, type BenchmarkFilter } from "../utils/benchmarkLabels";
import StatusPage from "../components/StatusPage";
import BenchmarkCropReview from "../components/DatasetAudit/benchmark/BenchmarkCropReview";
import EvaluationReviewer from "../components/DatasetAudit/benchmark/EvaluationReviewer";

const isFilter = (value: string | null): value is BenchmarkFilter => BENCHMARK_FILTERS.some((f) => f.value === value);

/** Full-screen labeling of one check's open benchmark, across datasets (Benchmark tab of the audit). */
export default function BenchmarkLabeling() {
	const { check } = useParams();
	const { user, status } = useAuth();
	const { canAudit, isLoading } = useCanAudit();
	const definition = BENCHMARK_CHECKS.find((c) => c.checkKey === check);
	if (status === "checking" || isLoading) return <Spin className="m-12" />;
	if (!user || !canAudit) {
		return <StatusPage kind="locked" title="Auditor access needed" description="Benchmark labeling is for the DeadTrees audit team." />;
	}
	if (!definition) return <StatusPage kind="not-found" title="No such benchmark" description="Open the Benchmark tab of the audit to pick one." />;
	return <Labeler checkKey={definition.checkKey} title={definition.title} />;
}

function Labeler({ checkKey, title }: { checkKey: AuditCheckKey; title: string }) {
	const { user } = useAuth();
	const [params, setParams] = useSearchParams();
	const { data: open, isLoading: openLoading } = useOpenBenchmarks();
	const benchmark = open?.find((b) => b.check_key === checkKey);
	const { data, isLoading, isError } = useBenchmark(benchmark);
	const { save, isPending } = useSaveBenchmarkLabel(benchmark?.id);
	const filter: BenchmarkFilter = isFilter(params.get("filter")) ? (params.get("filter") as BenchmarkFilter) : "open";
	// answered in this visit: they stay in "open for me" so ← goes back to them
	const [keep, setKeep] = useState<Set<number>>(new Set());
	const targets = useMemo(() => data?.targets ?? [], [data]);
	const shown = useMemo(() => filterTargets(targets, filter, checkKey, user?.id, keep), [targets, filter, checkKey, user?.id, keep]);
	const requested = Number(params.get("target"));
	const current = shown.find((t) => t.id === requested) ?? shown[0] ?? null;
	const left = targets.filter((t) => !answeredBy(t, user?.id)).length;

	const go = (target: IBenchmarkTarget | null, nextFilter: BenchmarkFilter = filter) => {
		const next = new URLSearchParams(params);
		next.set("filter", nextFilter);
		if (target) next.set("target", String(target.id));
		else next.delete("target");
		setParams(next, { replace: true });
	};
	const step = (by: 1 | -1) => {
		const id = stepCrop(shown, current?.id ?? null, by);
		go(shown.find((t) => t.id === id) ?? null);
	};
	const toNextOpen = () => {
		const next = nextOpen(shown, current?.id ?? null, user?.id) ?? nextOpen(targets, current?.id ?? null, user?.id);
		if (next) go(next);
		else message.success("Nothing left to label here.");
	};
	/** Stores a label; the crop review moves on by itself, a dataset moves on here. */
	const onSave = async (target: IBenchmarkTarget, rows: IAuditAnswerInput[], advance = false) => {
		try {
			await save(rows);
		} catch {
			message.error("Your label was not saved. Please try again.");
			return false;
		}
		setKeep((k) => new Set(k).add(target.id));
		const next = advance ? nextOpen(shown, target.id, user?.id) : null;
		if (next) go(next);
		return true;
	};

	if (openLoading || isLoading) return <Spin className="m-12" />;
	if (!benchmark) return <StatusPage kind="not-found" title={`No open ${title.toLowerCase()} benchmark`} description="An operator opens a new version when the current one is frozen." />;
	if (isError || !data) return <StatusPage kind="offline" title="The benchmark couldn’t load" description="Try again in a moment." />;
	const index = current ? shown.indexOf(current) : -1;

	return (
		<div className="flex min-h-[calc(100vh-64px)] flex-col gap-3 bg-white px-4 pb-6 pt-24 md:pt-28" data-testid="benchmark-labeling">
			<header className="flex flex-wrap items-center gap-3">
				<Link to="/dataset-audit?tab=benchmark" className="text-sm">
					← Benchmarks
				</Link>
				<div className="font-semibold">
					{title} · {benchmark.name} {benchmark.version}
				</div>
				<Segmented size="small" value={filter} onChange={(v) => go(null, v as BenchmarkFilter)} options={BENCHMARK_FILTERS} />
				<span className="text-sm text-gray-600" data-testid="benchmark-position">
					{current ? `${index + 1} / ${shown.length}` : `0 / ${shown.length}`}
				</span>
				{current && (
					<a href={`/dataset/${current.dataset_id}`} target="_blank" rel="noopener noreferrer" className="text-sm">
						Dataset {current.dataset_id} ↗
					</a>
				)}
				<span className="ml-auto text-sm" data-testid="benchmark-left">
					<b>{left}</b> of {targets.length} left for you
				</span>
			</header>
			{!current ? (
				<div className="flex flex-col items-start gap-2 p-8 text-sm text-gray-600">
					<span>{filter === "open" ? "You have labeled every target of this benchmark." : "No target matches this filter."}</span>
					{filter !== "all" && <Button onClick={() => go(null, "all")}>Show all</Button>}
				</div>
			) : checkKey === "prediction_quality" ? (
				<div className="min-h-[640px] flex-1">
					<BenchmarkCropReview targets={shown} current={current} userId={user?.id} onSelect={(t) => go(t)} onSave={onSave} />
				</div>
			) : (
				<EvaluationReviewer
					key={current.id}
					datasetId={current.dataset_id}
					runId={current.run_id}
					images={current.images}
					mine={current.people.find((p) => p.assessor_user_id === user?.id) ?? null}
					others={current.people.filter((p) => p.assessor_user_id !== user?.id)}
					models={current.models}
					blind
					onSave={(row) => onSave(current, [row], true)}
					saving={isPending}
					keys={{ ArrowRight: () => step(1), ArrowLeft: () => step(-1), Tab: toNextOpen }}
				/>
			)}
		</div>
	);
}
