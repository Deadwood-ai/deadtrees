import { useNavigate } from "react-router-dom";
import { Button, Spin } from "antd";
import { useAuth } from "../../../hooks/useAuthProvider";
import { BENCHMARK_CHECKS, useBenchmark, useOpenBenchmarks } from "../../../hooks/useAuditBenchmarks";
import type { AuditCheckKey, IAuditBenchmark } from "../../../types/auditChecks";
import { answeredBy, labelersDisagree } from "../../../utils/benchmarkLabels";

/** The Benchmark tab of the audit: one card per check with an open benchmark version, with
 * what is left for you and where labelers disagree. */
export default function BenchmarkTab() {
	const { data: open, isLoading, isError } = useOpenBenchmarks();
	if (isLoading) return <Spin />;
	if (isError) return <div className="text-sm text-red-600">The benchmarks couldn’t load. The audit tables may not be reachable on this server yet.</div>;
	return (
		<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
			{BENCHMARK_CHECKS.map(({ checkKey, title }) => (
				<BenchmarkCard key={checkKey} checkKey={checkKey} title={title} benchmark={open?.find((b) => b.check_key === checkKey)} />
			))}
		</div>
	);
}

function BenchmarkCard({ checkKey, title, benchmark }: { checkKey: AuditCheckKey; title: string; benchmark: IAuditBenchmark | undefined }) {
	const { user } = useAuth();
	const navigate = useNavigate();
	const { data, isLoading } = useBenchmark(benchmark);
	const targets = data?.targets ?? [];
	const left = targets.filter((t) => !answeredBy(t, user?.id)).length;
	const disagree = targets.filter((t) => labelersDisagree(checkKey, t.people)).length;
	const to = (filter: string) => `/dataset-audit/benchmark/${checkKey}?filter=${filter}`;
	return (
		<div className="flex flex-col gap-2 rounded-xl border border-gray-200 p-4" data-testid={`benchmark-card-${checkKey}`}>
			<div className="flex items-baseline justify-between gap-2">
				<h3 className="m-0 text-base font-semibold">{title}</h3>
				{benchmark && (
					<span className="text-xs text-gray-500">
						{benchmark.name} {benchmark.version}
					</span>
				)}
			</div>
			{!benchmark ? (
				<div className="text-sm text-gray-500">No open version.</div>
			) : isLoading ? (
				<Spin size="small" />
			) : (
				<>
					<div className="text-sm">
						<b data-testid={`benchmark-open-${checkKey}`}>{left}</b> open for you · {targets.length} {checkKey === "prediction_quality" ? "crops" : "datasets"} · {disagree} where labelers disagree
					</div>
					<div className="flex flex-wrap gap-2">
						<Button type="primary" disabled={!left} onClick={() => navigate(to("open"))}>
							Label
						</Button>
						<Button onClick={() => navigate(to("all"))}>All</Button>
						<Button disabled={!disagree} onClick={() => navigate(to("disagree"))}>
							Labelers disagree
						</Button>
					</div>
				</>
			)}
		</div>
	);
}
