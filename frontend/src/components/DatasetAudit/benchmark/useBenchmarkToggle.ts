import { useState } from "react";
import { message } from "antd";
import { useCanOperate } from "../../../hooks/useUserPrivileges";
import { useAddBenchmarkTarget, useBenchmarkMembership, useRemoveBenchmarkTarget } from "../../../hooks/useAuditBenchmarks";
import type { BenchmarkRef } from "../../../types/auditChecks";
import { sameBenchmark } from "../../../utils/benchmarkLabels";

export interface IBenchmarkToggle {
	/** the target is in the benchmark's open version, as the server said after the last call */
	isMember: (cropId: number | null) => boolean;
	/** adds the target, or takes it out again */
	toggle: (cropId: number | null) => Promise<void>;
	/** a call runs, or the membership is being read again: the toggle waits */
	pending: boolean;
}

/** Membership of a dataset (cropId null) or one of its crops in the open version of a benchmark
 * (a check, and for prediction quality a layer), for operators: add with audit.add_benchmark_target, remove with
 * audit.remove_benchmark_target. The membership is read again after every call, and the toggle
 * is off while a call runs. Undefined for everyone else, so callers show nothing. */
export function useBenchmarkToggle(benchmark: BenchmarkRef, datasetId: number): IBenchmarkToggle | undefined {
	const { canOperate } = useCanOperate();
	const membership = useBenchmarkMembership(canOperate ? datasetId : undefined);
	const add = useAddBenchmarkTarget();
	const remove = useRemoveBenchmarkTarget(undefined);
	const [running, setRunning] = useState(false);
	if (!canOperate) return undefined;

	const isMember = (cropId: number | null) =>
		!!membership.data?.some((m) => sameBenchmark(m.benchmark, benchmark) && m.crop_id === cropId);
	const pending = running || membership.isFetching || membership.isLoading;
	const toggle = async (cropId: number | null) => {
		if (pending) return;
		const leaving = isMember(cropId);
		const what = cropId === null ? "dataset" : "crop";
		setRunning(true);
		try {
			if (leaving) await remove.mutateAsync({ benchmark, datasetId, cropId });
			else await add.mutateAsync({ benchmark, datasetId, cropId });
			message.success(leaving ? `The ${what} left the benchmark` : `The ${what} is in the benchmark`);
		} catch (error) {
			message.error(`${leaving ? "Not removed from" : "Not added to"} the benchmark: ${(error as { message?: string }).message ?? "please try again"}`);
			// whatever happened, show what the server holds now
			await membership.refetch();
		} finally {
			setRunning(false);
		}
	};
	return { isMember, toggle, pending };
}
