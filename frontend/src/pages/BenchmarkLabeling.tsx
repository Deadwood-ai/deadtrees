import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Segmented, Spin, message } from "antd";
import { useAuth } from "../hooks/useAuthProvider";
import { useCanAudit, useCanOperate } from "../hooks/useUserPrivileges";
import { useBenchmark, useBenchmarkCandidate, useSaveBenchmarkLabel } from "../hooks/useAuditBenchmarks";
import type { DatasetReviewInput, TileReviewInput } from "../types/auditChecks";
import { stepCrop } from "../utils/auditChecks";
import { BENCHMARKS, nextOpen, targetKey, targetNoun, type BenchmarkMode, type IBenchmarkTarget, type ITileTarget } from "../utils/benchmarkLabels";
import StatusPage from "../components/StatusPage";
import { useAuditShortcuts } from "../components/DatasetAudit/checks/useAuditShortcuts";
import BenchmarkCropReview from "../components/DatasetAudit/benchmark/BenchmarkCropReview";
import EvaluationReviewer from "../components/DatasetAudit/benchmark/EvaluationReviewer";
import RemoveFromBenchmark from "../components/DatasetAudit/benchmark/RemoveFromBenchmark";

/** Full-screen labeling of one benchmark, across datasets (Benchmark tab of the audit): label new
 * random targets one after the other (operators; each joins the benchmark with its label, then
 * the next one is drawn), or review the existing labels. */
export default function BenchmarkLabeling() {
	const { benchmark: key } = useParams();
	const { user, status } = useAuth();
	const { canAudit, isLoading } = useCanAudit();
	const definition = BENCHMARKS.find((b) => b.key === key);
	if (status === "checking" || isLoading) return <Spin className="m-12" />;
	if (!user || !canAudit) {
		return <StatusPage kind="locked" title="Auditor access needed" description="Benchmark labeling is for the DeadTrees audit team." />;
	}
	if (!definition) return <StatusPage kind="not-found" title="No such benchmark" description="Open the Benchmark tab of the audit to pick one." />;
	return <Labeler definition={definition} />;
}

function Labeler({ definition }: { definition: (typeof BENCHMARKS)[number] }) {
	const { key, layer, title } = definition;
	const [params, setParams] = useSearchParams();
	const { canOperate } = useCanOperate();
	const mode: BenchmarkMode = params.get("mode") === "review" ? "review" : "new";
	const { data: labeled = [], isLoading, isError } = useBenchmark(key);
	const candidate = useBenchmarkCandidate(key, mode === "new" && canOperate);
	const { save, isPending } = useSaveBenchmarkLabel(key);
	const targets = useMemo(() => (mode === "new" ? (candidate.data ? [candidate.data] : []) : labeled), [mode, candidate.data, labeled]);
	const requested = params.get("target");
	const current = targets.find((t) => targetKey(t) === requested) ?? targets[0] ?? null;
	const noun = targetNoun(!!layer);

	const go = (target: IBenchmarkTarget | null, nextMode: BenchmarkMode = mode) => {
		const next = new URLSearchParams(params);
		next.set("mode", nextMode);
		if (target) next.set("target", targetKey(target));
		else next.delete("target");
		setParams(next, { replace: true });
	};
	const step = (by: 1 | -1) => {
		const id = stepCrop(targets, current?.id ?? null, by);
		go(targets.find((t) => t.id === id) ?? null);
	};
	const toNextOpen = () => {
		const next = nextOpen(targets, current?.id ?? null);
		if (next) go(next);
	};

	/** Stores a label, which puts the target into the benchmark. A new target is followed by the
	 * next random one; in review the crop review moves on by itself, a dataset moves on here. */
	const onSave = async (target: IBenchmarkTarget, review: DatasetReviewInput | TileReviewInput, advance = false) => {
		try {
			await save(target, review);
		} catch {
			message.error("Your label was not saved. Please try again.");
			return false;
		}
		if (mode === "new") void candidate.next().then(() => go(null));
		else if (advance) {
			const next = nextOpen(targets, target.id);
			if (next) go(next);
		}
		return true;
	};

	/** Skip (K): the next random target, without labeling this one. */
	const skip = () => void candidate.skip().then(() => go(null));
	useAuditShortcuts({ k: skip }, mode === "new" && !!current && !candidate.isFetching);

	/** After a removal: on to the next labeled target. */
	const onRemoved = (removed: IBenchmarkTarget[]) => {
		const gone = (t: IBenchmarkTarget) => removed.some((r) => r.dataset_id === t.dataset_id && r.tile_id === t.tile_id);
		const at = current ? targets.indexOf(current) : -1;
		go(targets.slice(at + 1).find((t) => !gone(t)) ?? [...targets].reverse().find((t) => !gone(t)) ?? null);
	};

	if (isLoading) return <Spin className="m-12" />;
	if (isError) return <StatusPage kind="offline" title="The benchmark couldn’t load" description="Try again in a moment." />;

	const index = current ? targets.indexOf(current) : -1;
	return (
		<div className="flex h-screen flex-col gap-3 overflow-hidden bg-white px-4 pb-4 pt-24 md:pt-28" data-testid="benchmark-labeling">
			<header className="flex flex-wrap items-center gap-3">
				<Link to="/dataset-audit?tab=benchmark" className="text-sm">
					← Benchmarks
				</Link>
				<div className="font-semibold">{title} benchmark</div>
				<Segmented
					size="small"
					value={mode}
					onChange={(v) => go(null, v as BenchmarkMode)}
					options={[
						{ value: "new", label: `Label new random ${noun}`, disabled: !canOperate },
						{ value: "review", label: "Review existing labels" },
					]}
				/>
				{mode === "review" && (
					<span className="text-sm text-gray-600" data-testid="benchmark-position">
						{current ? `${index + 1} / ${targets.length}` : `0 / ${targets.length}`}
					</span>
				)}
				{current && (
					<a href={`/dataset/${current.dataset_id}`} target="_blank" rel="noopener noreferrer" className="text-sm">
						Dataset {current.dataset_id} ↗
					</a>
				)}
				{/* mounted without a target too, so Undo survives a removal of the last label */}
				{mode === "review" && (
					<RemoveFromBenchmark
						benchmark={key}
						target={current}
						datasetTargets={current ? targets.filter((t) => t.dataset_id === current.dataset_id) : []}
						onRemoved={onRemoved}
						active
					/>
				)}
				<span className="ml-auto text-sm" data-testid="benchmark-left">
					<b>{labeled.length}</b> labeled {noun} in the benchmark
				</span>
			</header>
			{mode === "new" && !canOperate ? (
				<div className="p-8 text-sm text-gray-600">Adding to a benchmark is for operators: only they label new random {noun}.</div>
			) : mode === "new" && candidate.isFetching ? (
				<Spin className="m-12" />
			) : !current ? (
				<div className="p-8 text-sm text-gray-600">{mode === "new" ? `No ${noun} left that are not in the benchmark yet.` : `The benchmark has no labeled ${noun} yet.`}</div>
			) : layer ? (
				// the crop review fits the screen: the images shrink, the answer panel scrolls
				<div className="min-h-0 flex-1">
					<BenchmarkCropReview
						layer={layer}
						targets={targets as ITileTarget[]}
						current={current as ITileTarget}
						onSelect={(t) => go(t)}
						onSave={onSave}
						onSkip={mode === "new" ? skip : undefined}
					/>
				</div>
			) : (
				current.tile_id === null && (
					<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
						<EvaluationReviewer
							key={targetKey(current)}
							datasetId={current.dataset_id}
							images={current.images}
							label={current.label}
							models={current.models}
							blind
							onSave={(review) => onSave(current, review, true)}
							saving={isPending}
							onSkip={mode === "new" ? skip : undefined}
							keys={{ ArrowRight: () => step(1), ArrowLeft: () => step(-1), Tab: toNextOpen }}
						/>
					</div>
				)
			)}
		</div>
	);
}
